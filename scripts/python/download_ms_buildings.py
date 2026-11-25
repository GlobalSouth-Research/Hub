import argparse
from pathlib import Path
import geopandas as gpd
import pandas as pd
import rasterio
from rasterio.warp import transform_bounds
from shapely.geometry import box
import pystac_client
import planetary_computer


def get_ms_buildings(input_path: str | Path, expand_factor: float = 1.0, output_dir: str | Path | None = None):
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

    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    items = list(catalog.search(collections=["ms-buildings"], bbox=bbox).items())
    aoi_gdf = gpd.GeoDataFrame(geometry=[box(*bbox)], crs="EPSG:4326")

    gdfs = [gpd.read_parquet(item.assets["data"].href, bbox=bbox) for item in items if "data" in item.assets]
    if not gdfs:
        print("No building footprints found in this bounding box.")
        return bbox_str

    merged = gpd.clip(gpd.GeoDataFrame(pd.concat(gdfs, ignore_index=True), crs="EPSG:4326"), aoi_gdf)
    out_file = out_dir / "ms_global_buildings.gpkg"
    merged.to_file(out_file, driver="GPKG")
    print(f"Successfully downloaded {len(merged)} buildings to: {out_file}")

    return bbox_str


def main():
    parser = argparse.ArgumentParser(description="Download Microsoft Global Building Footprints from a spatial file.")
    parser.add_argument("input", type=Path, help="Path to input .tif or .gpkg file")
    parser.add_argument("--output", type=Path, default=None, help="Output directory")
    parser.add_argument("--expand", type=float, default=1.0, help="Factor to expand the bounding box (default: 1.0)")
    args = parser.parse_args()

    get_ms_buildings(input_path=args.input, expand_factor=args.expand, output_dir=args.output)


if __name__ == "__main__":
    main()

    # Alternatively uncomment the following section if executing from python
    # get_ms_buildings(input_path="your input file", expand_factor=1.0)