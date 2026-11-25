import argparse
from pathlib import Path
import geopandas as gpd
import pyarrow.parquet as pq
import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from rasterio.transform import from_origin
import requests

INDEX_PARQUET_URL = "https://data.source.coop/tge-labs/aef/v1/annual/aef_index.parquet"
BASE_URL = "https://data.source.coop/tge-labs/aef/v1/annual"


def _resolve_cog_url(raw_path: str) -> str:
    """Normalizes the index `path` column into a direct HTTPS COG URL."""
    val = str(raw_path).strip()
    if val.startswith("http://") or val.startswith("https://"):
        return val
    if val.startswith("s3://us-west-2.opendata.source.coop/"):
        return val.replace("s3://us-west-2.opendata.source.coop/", "https://data.source.coop/", 1)
    if val.startswith("gs://alphaearth_foundations/"):
        return val.replace("gs://alphaearth_foundations/", "https://storage.googleapis.com/alphaearth_foundations/", 1)
    return f"{BASE_URL}/{val.lstrip('/')}"


def _get_local_index(cache_dir: Path) -> Path:
    """Downloads and caches the AlphaEarth Parquet index locally so PyArrow can filter it."""
    local_index = cache_dir / "aef_index.parquet"
    if not local_index.exists():
        print("Downloading AlphaEarth spatial index (one-time cache)...")
        with requests.get(INDEX_PARQUET_URL, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(local_index, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    f.write(chunk)
    return local_index


def get_alphaearth(
    input_path: str | Path,
    year: int = 2023,
    expand_factor: float = 1.0,
    output_dir: str | Path | None = None,
):
    input_path = Path(input_path)
    if not input_path.exists():
        raise FileNotFoundError(f"Error: Input file {input_path} does not exist.")

    out_dir = input_path.parent if output_dir is None else input_path.parent / output_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    ext = input_path.suffix.lower()
    if ext in {".gpkg", ".shp", ".geojson"}:
        gdf = gpd.read_file(input_path)
        if gdf.crs != "EPSG:4326":
            gdf = gdf.to_crs("EPSG:4326")
        minx, miny, maxx, maxy = gdf.total_bounds
    elif ext in {".tif", ".tiff"}:
        with rasterio.open(input_path) as src:
            minx, miny, maxx, maxy = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
    else:
        raise ValueError(f"Unsupported file format: {ext}. Use .tif, .gpkg, .shp, or .geojson.")

    if expand_factor != 1.0:
        center_lon = (minx + maxx) / 2.0
        center_lat = (miny + maxy) / 2.0
        half_width = ((maxx - minx) / 2.0) * expand_factor
        half_height = ((maxy - miny) / 2.0) * expand_factor
        minx, miny = center_lon - half_width, center_lat - half_height
        maxx, maxy = center_lon + half_width, center_lat + half_height

    bbox = (minx, miny, maxx, maxy)
    bbox_str = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}"
    print(f"Computed BBox (expanded {expand_factor}x): {bbox_str}")

    local_index = _get_local_index(out_dir)

    print(f"Querying AlphaEarth spatial index for year {year}...")
    cols = ["year", "path", "wgs84_west", "wgs84_south", "wgs84_east", "wgs84_north"]
    df = pq.read_table(
        local_index,
        columns=cols,
        filters=[("year", "==", int(year))],
    ).to_pandas()

    hits = df[
        (df["wgs84_west"] < maxx)
        & (df["wgs84_east"] > minx)
        & (df["wgs84_south"] < maxy)
        & (df["wgs84_north"] > miny)
    ]

    if hits.empty:
        print(f"No AlphaEarth embedding tiles found for year {year} in bbox {bbox_str}.")
        return bbox_str

    for _, row in hits.iterrows():
        cog_url = _resolve_cog_url(row["path"])
        tile_name = Path(cog_url).stem
        print(f"Streaming & clipping 64-band COG: {tile_name}...")

        with rasterio.open(cog_url) as src:
            utm_minx, utm_miny, utm_maxx, utm_maxy = transform_bounds("EPSG:4326", src.crs, *bbox)
            if src.transform.e < 0:
                win = from_bounds(utm_minx, utm_miny, utm_maxx, utm_maxy, src.transform)
            else:
                win = from_bounds(utm_minx, utm_maxy, utm_maxx, utm_miny, src.transform)

            win = win.round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            data = src.read(window=win)

            win_transform = src.window_transform(win)
            if win_transform.e > 0:
                data = data[:, ::-1, :]
                win_transform = from_origin(
                    win_transform.c,
                    win_transform.f + win.height * win_transform.e,
                    abs(win_transform.a),
                    abs(win_transform.e),
                )

            profile = src.profile.copy()
            profile.update(
                height=data.shape[1],
                width=data.shape[2],
                transform=win_transform,
                compress="LZW",
            )

            out_file = out_dir / f"alphaearth_{year}_{tile_name}.tif"
            with rasterio.open(out_file, "w", **profile) as dst:
                dst.write(data)
            print(f"Successfully downloaded data to: {out_file}")

    return bbox_str


def main():
    parser = argparse.ArgumentParser(description="Download AlphaEarth 64-band Embeddings directly from public COGs.")
    parser.add_argument("input", type=Path, help="Path to input .tif or .gpkg file")
    parser.add_argument("--year", type=int, default=2023, help="Year to download (2017-2025, default: 2023)")
    parser.add_argument("--output", type=Path, default=None, help="Output directory")
    parser.add_argument("--expand", type=float, default=1.0, help="Factor to expand the bounding box (default: 1.0)")
    args = parser.parse_args()

    get_alphaearth(input_path=args.input, year=args.year, expand_factor=args.expand, output_dir=args.output)


if __name__ == "__main__":
    # main()

    # Alternatively uncomment the following section if executing from python
    get_alphaearth(input_path="/home/caipi/dorndorf.gpkg", year=2023, expand_factor=1.0)