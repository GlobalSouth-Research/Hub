import argparse
import math
import zipfile
from pathlib import Path
import geopandas as gpd
import rasterio
from rasterio.warp import transform_bounds
from shapely.geometry import box
import requests
import rioxarray


def get_ghsl_tile_ids(bbox_wgs84: tuple[float, float, float, float]) -> list[str]:
    """Computes JRC R2023A 1000km Mollweide (ESRI:54009) tile IDs (e.g., 'R4_C19') intersecting the bbox."""
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", "ESRI:54009", *bbox_wgs84)

    # JRC GHSL Mollweide grid origin (top-left) and 1,000,000 m tile size
    origin_x = -18041000.0
    origin_y = 9000000.0
    tile_size = 1000000.0

    col_min = max(1, math.floor((minx - origin_x) / tile_size) + 1)
    col_max = min(36, math.floor((maxx - origin_x) / tile_size) + 1)
    row_min = max(1, math.floor((origin_y - maxy) / tile_size) + 1)
    row_max = min(18, math.floor((origin_y - miny) / tile_size) + 1)

    return [f"R{r}_C{c}" for r in range(row_min, row_max + 1) for c in range(col_min, col_max + 1)]


def get_ghsl_built(
    input_path: str | Path,
    year: int = 2020,
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

    tile_ids = get_ghsl_tile_ids(bbox)
    print(f"Intersecting JRC Mollweide tile(s): {tile_ids}")

    aoi_gdf = gpd.GeoDataFrame(geometry=[box(*bbox)], crs="EPSG:4326")

    for tile_id in tile_ids:
        base_name = f"GHS_BUILT_S_E{year}_GLOBE_R2023A_54009_100_V1_0_{tile_id}"
        tile_url = (
            f"https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A/"
            f"GHS_BUILT_S_E{year}_GLOBE_R2023A_54009_100/V1-0/tiles/{base_name}.zip"
        )
        zip_path = out_dir / f"{base_name}.zip"
        tif_path = out_dir / f"{base_name}.tif"

        print(f"Downloading tile {tile_id}...")
        with requests.get(tile_url, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(zip_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    f.write(chunk)

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extract(f"{base_name}.tif", path=out_dir)

        # Clip locally using windowed read (very low RAM)
        with rioxarray.open_rasterio(tif_path) as da:
            aoi_proj = aoi_gdf.to_crs(da.rio.crs)
            clipped = da.rio.clip(aoi_proj.geometry, drop=True)
            out_file = out_dir / f"ghs_built_s_{year}_{tile_id}.tif"
            clipped.rio.to_raster(out_file, compress="LZW")

        # Clean up temporary full tile files
        zip_path.unlink(missing_ok=True)
        tif_path.unlink(missing_ok=True)
        print(f"Successfully downloaded data to: {out_file}")

    return bbox_str


def main():
    parser = argparse.ArgumentParser(description="Download GHSL Built-up Surface (GHS-BUILT-S) from a spatial file.")
    parser.add_argument("input", type=Path, help="Path to input .tif or .gpkg file")
    parser.add_argument("--year", type=int, default=2020, help="Epoch year (e.g., 1975..2030 in 5-yr steps, default: 2020)")
    parser.add_argument("--output", type=Path, default=None, help="Output directory")
    parser.add_argument("--expand", type=float, default=1.0, help="Factor to expand the bounding box (default: 1.0)")
    args = parser.parse_args()

    get_ghsl_built(input_path=args.input, year=args.year, expand_factor=args.expand, output_dir=args.output)


if __name__ == "__main__":
    # main()

    # Alternatively uncomment the following section if executing from python
    get_ghsl_built(input_path="/home/caipi/dorndorf.gpkg", year=2020, expand_factor=1.0)