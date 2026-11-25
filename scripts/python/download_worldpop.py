import argparse
from pathlib import Path
import geopandas as gpd
import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
import requests


def _resolve_worldpop_url(iso3: str, year: int, constrained: bool) -> str:
    """Resolves the direct WorldPop GeoTIFF URL without relying on the flaky REST API."""
    iso_up = iso3.upper()
    iso_lo = iso3.lower()

    if constrained:
        candidates = [
            f"https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/{year}/BSGM/{iso_up}/{iso_lo}_ppp_{year}_UNadj_constrained.tif",
            f"https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/{year}/maxar_v1/{iso_up}/{iso_lo}_ppp_{year}_UNadj_constrained.tif",
        ]
    else:
        candidates = [
            f"https://data.worldpop.org/GIS/Population/Global_2000_2020/{year}/{iso_up}/{iso_lo}_ppp_{year}_UNadj.tif",
            f"https://data.worldpop.org/GIS/Population/Global_2000_2020/{year}/{iso_up}/{iso_lo}_ppp_{year}.tif",
        ]

    headers = {"User-Agent": "Mozilla/5.0"}
    for url in candidates:
        resp = requests.head(url, headers=headers, allow_redirects=True, timeout=20)
        if resp.status_code == 200:
            return url

    raise FileNotFoundError(
        f"Could not find WorldPop GeoTIFF for ISO3={iso_up}, year={year}, constrained={constrained}. "
        f"Checked: {candidates}"
    )


def get_worldpop(
    input_path: str | Path,
    iso3: str = "DEU",
    year: int = 2020,
    constrained: bool = False,
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

    tif_url = _resolve_worldpop_url(iso3=iso3, year=year, constrained=constrained)
    mode = "constrained" if constrained else "unconstrained"
    temp_tif = out_dir / f"_tmp_worldpop_{iso3.lower()}_{year}_{mode}.tif"
    out_file = out_dir / f"worldpop_{iso3.lower()}_{year}_{mode}.tif"

    print(f"Downloading country raster in chunks from: {tif_url}")
    with requests.get(tif_url, headers={"User-Agent": "Mozilla/5.0"}, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(temp_tif, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)

    try:
        with rasterio.open(temp_tif) as src:
            win = from_bounds(*bbox, src.transform)
            win = win.round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            data = src.read(window=win)

            profile = src.profile.copy()
            profile.update(
                height=data.shape[1],
                width=data.shape[2],
                transform=src.window_transform(win),
                compress="LZW",
            )

            with rasterio.open(out_file, "w", **profile) as dst:
                dst.write(data)
            print(f"Successfully downloaded data to: {out_file}")
    finally:
        temp_tif.unlink(missing_ok=True)

    return bbox_str


def main():
    parser = argparse.ArgumentParser(description="Download WorldPop (Unconstrained or Constrained) from a spatial file.")
    parser.add_argument("input", type=Path, help="Path to input .tif or .gpkg file")
    parser.add_argument("--iso3", type=str, required=True, help="3-letter ISO country code (e.g., DEU, NGA, KEN)")
    parser.add_argument("--year", type=int, default=2020, help="Target year (2000-2020, default: 2020)")
    parser.add_argument("--constrained", action="store_true", help="Use building-constrained population dataset")
    parser.add_argument("--output", type=Path, default=None, help="Output directory")
    parser.add_argument("--expand", type=float, default=1.0, help="Factor to expand the bounding box (default: 1.0)")
    args = parser.parse_args()

    get_worldpop(
        input_path=args.input,
        iso3=args.iso3,
        year=args.year,
        constrained=args.constrained,
        expand_factor=args.expand,
        output_dir=args.output,
    )


if __name__ == "__main__":
    # main()

    # Alternatively uncomment the following section if executing from python
    get_worldpop(input_path="/home/caipi/dorndorf.gpkg", iso3="DEU", year=2020, constrained=False, expand_factor=1.0)