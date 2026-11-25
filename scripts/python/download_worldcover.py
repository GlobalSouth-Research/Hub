import argparse
from pathlib import Path
import geopandas as gpd
import rasterio
from rasterio.warp import transform_bounds
from shapely.geometry import box
import pystac_client
import planetary_computer
import rioxarray


def get_worldcover(input_path: str | Path, year: int = 2021, expand_factor: float = 1.0, output_dir: str | Path | None = None):
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
    version = "1.0.0" if year == 2020 else "2.0.0"
    items = list(
        catalog.search(
            collections=["esa-worldcover"],
            bbox=bbox,
            query={"esa_worldcover:product_version": {"eq": version}},
        ).items()
    )
    aoi_gdf = gpd.GeoDataFrame(geometry=[box(*bbox)], crs="EPSG:4326")

    for item in items:
        da = rioxarray.open_rasterio(item.assets["map"].href, chunks="auto")
        clipped = da.rio.clip(aoi_gdf.geometry, crs="EPSG:4326", drop=True)
        out_file = out_dir / f"esa_worldcover_{year}_{item.id}.tif"
        clipped.rio.to_raster(out_file, compress="LZW")
        print(f"Successfully downloaded data to: {out_file}")

    return bbox_str


def main():
    parser = argparse.ArgumentParser(description="Download ESA WorldCover 10m from a spatial file.")
    parser.add_argument("input", type=Path, help="Path to input .tif or .gpkg file")
    parser.add_argument("--year", type=int, default=2021, choices=[2020, 2021], help="Year (2020 or 2021, default: 2021)")
    parser.add_argument("--output", type=Path, default=None, help="Output directory")
    parser.add_argument("--expand", type=float, default=1.0, help="Factor to expand the bounding box (default: 1.0)")
    args = parser.parse_args()

    get_worldcover(input_path=args.input, year=args.year, expand_factor=args.expand, output_dir=args.output)


if __name__ == "__main__":
    # main()

    # Alternatively uncomment the following section if executing from python
    get_worldcover(input_path="/home/caipi/dorndorf.gpkg", year=2021, expand_factor=1.0)