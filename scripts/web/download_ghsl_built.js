import * as GeoTIFF from "https://esm.sh/geotiff@2.1.3";

const viaProxy = (url) => `/proxy?url=${encodeURIComponent(url)}`;

function getGhslTileIds(mollweideBounds) {
    const [minx, miny, maxx, maxy] = mollweideBounds;
    const originX = -18041000.0;
    const originY = 9000000.0;
    const tileSize = 1000000.0;

    const colMin = Math.max(1, Math.floor((minx - originX) / tileSize) + 1);
    const colMax = Math.min(36, Math.floor((maxx - originX) / tileSize) + 1);
    const rowMin = Math.max(1, Math.floor((originY - maxy) / tileSize) + 1);
    const rowMax = Math.min(18, Math.floor((originY - miny) / tileSize) + 1);

    const tiles = [];
    for (let r = rowMin; r <= rowMax; r++) {
        for (let c = colMin; c <= colMax; c++) {
            tiles.push(`R${r}_C${c}`);
        }
    }
    return tiles;
}

const PY_GHSL_HELPERS = `
import zipfile, os, numpy as np, tifffile

def unzip_single_tif(zip_fn, tif_inside):
    with zipfile.ZipFile(zip_fn, "r") as zf:
        data = zf.read(tif_inside)
    os.remove(zip_fn)
    return data

def write_ghsl_mollweide_tif(out_fn, shape_json, dtype_str, x0, y0, sx, sy, nodata):
    import json
    shape = tuple(json.loads(shape_json))
    arr = np.frombuffer(_raster_buf.to_py(), dtype=np.dtype(dtype_str)).reshape(shape)

    # Full GeoTIFF 1.0 Mollweide definition (CT_Mollweide = 24, WGS84 datum)
    # so GDAL / QGIS / rasterio recognize World Mollweide natively without ESRI:54009 lookup
    geokeys = (
        1, 1, 0, 12,
        1024, 0, 1, 1,        # GTModelTypeGeoKey: ModelTypeProjected
        1025, 0, 1, 1,        # GTRasterTypeGeoKey: RasterPixelIsArea
        1026, 34737, 15, 0,   # GTCitationGeoKey: "World_Mollweide"
        2048, 0, 1, 4326,     # GeographicTypeGeoKey: GCS_WGS_84
        2054, 0, 1, 9102,     # GeogAngularUnitsGeoKey: Angular_Degree
        3072, 0, 1, 32767,    # ProjectedCSTypeGeoKey: user-defined
        3074, 0, 1, 32767,    # ProjectionGeoKey: user-defined
        3075, 0, 1, 24,       # ProjCoordTransGeoKey: CT_Mollweide (24)
        3076, 0, 1, 9001,     # ProjLinearUnitsGeoKey: Linear_Meter
        3080, 34736, 1, 0,    # ProjNatOriginLongGeoKey: 0.0
        3088, 34736, 1, 1,    # ProjCenterLongGeoKey: 0.0
        3082, 34736, 1, 2,    # ProjFalseEastingGeoKey: 0.0
    )
    geo_ascii = "World_Mollweide|"
    geo_doubles = (0.0, 0.0, 0.0)

    extratags = [
        (33550, "d", 3, (float(sx), float(sy), 0.0), True),
        (33922, "d", 6, (0.0, 0.0, 0.0, float(x0), float(y0), 0.0), True),
        (34735, "H", len(geokeys), geokeys, True),
        (34736, "d", len(geo_doubles), geo_doubles, True),
        (34737, "s", len(geo_ascii), geo_ascii, True),
    ]
    if nodata is not None:
        extratags.append((42113, "s", 0, str(nodata), True))

    tifffile.imwrite(
        out_fn,
        np.ascontiguousarray(arr),
        photometric="minisblack",
        extratags=extratags,
        compression="zlib",
    )
    outputs.append(out_fn)
    print(f"Wrote clipped Mollweide GeoTIFF {out_fn}: {shape[1]}x{shape[0]} px")
`;

export const ghslBuiltPlugin = {
    id: "ghsl_built",
    description: "Streams GHSL Built-up Surface (GHS-BUILT-S, 100m) from official JRC regional tiles.",
    bundleName: "ghsl_built_tiffs.zip",
    controlsHTML: `
        <div class="mb-3">
            <label for="ghsl-built-year" class="block text-sm font-medium text-gray-700 mb-2">Epoch Year</label>
            <select id="ghsl-built-year" class="w-full border border-gray-300 rounded-lg p-2.5 bg-white">
                <option value="2030">2030 (Projected)</option>
                <option value="2025">2025 (Projected)</option>
                <option value="2020" selected>2020</option>
                <option value="2015">2015</option>
                <option value="2010">2010</option>
                <option value="2005">2005</option>
                <option value="2000">2000</option>
                <option value="1995">1995</option>
                <option value="1990">1990</option>
                <option value="1985">1985</option>
                <option value="1980">1980</option>
                <option value="1975">1975</option>
            </select>
        </div>
        <div class="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
            <strong>GHS-BUILT-S (100m):</strong> Built-up surface area (m² per 100m grid cell) in World Mollweide (<code>ESRI:54009</code>).
        </div>
    `,

    async init(pyodide) {
        pyodide.runPython(PY_GHSL_HELPERS);
    },

    async run({ pyodide, bounds, log, setStatus }) {
        const year = document.getElementById("ghsl-built-year").value;
        const mollBounds = JSON.parse(
            pyodide.globals.get("bounds_in_crs")(...bounds, "ESRI:54009")
        );
        const tileIds = getGhslTileIds(mollBounds);
        log(`[ghsl_built] Mollweide bounds:`, mollBounds, `Tiles:`, tileIds);

        let written = 0;
        for (const tileId of tileIds) {
            const baseName = `GHS_BUILT_S_E${year}_GLOBE_R2023A_54009_100_V1_0_${tileId}`;
            const jrcUrl =
                `https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A/` +
                `GHS_BUILT_S_E${year}_GLOBE_R2023A_54009_100/V1-0/tiles/${baseName}.zip`;

            log(`[ghsl_built] Fetching JRC archive:`, jrcUrl);
            setStatus(`Bear is downloading JRC tile ${tileId} (${year})...`);

            const resp = await fetch(viaProxy(jrcUrl));
            if (!resp.ok) {
                throw new Error(`JRC download failed for ${tileId} (HTTP ${resp.status})`);
            }
            const zipBytes = new Uint8Array(await resp.arrayBuffer());
            log(`[ghsl_built] Downloaded ${baseName}.zip (${(zipBytes.byteLength / (1024 * 1024)).toFixed(2)} MB)`);

            setStatus(`Bear is unzipping & clipping ${tileId} to your AOI...`);
            const zipFn = `${baseName}.zip`;
            const tifInside = `${baseName}.tif`;

            pyodide.FS.writeFile(zipFn, zipBytes);
            const pyBytes = pyodide.globals.get("unzip_single_tif")(zipFn, tifInside);
            const tifBuffer = pyBytes.toJs().buffer;
            pyBytes.destroy();

            const tiff = await GeoTIFF.fromArrayBuffer(tifBuffer);
            const image = await tiff.getImage();

            const imgWidth = image.getWidth();
            const imgHeight = image.getHeight();
            const [resX, resY] = image.getResolution();
            const sx = Math.abs(resX);
            const sy = Math.abs(resY);
            const [originX, originY] = image.getOrigin();

            // Compute exact pixel window [col0, row0, col1, row1] in Mollweide grid
            const col0 = Math.max(0, Math.floor((mollBounds[0] - originX) / sx));
            const col1 = Math.min(imgWidth, Math.ceil((mollBounds[2] - originX) / sx));
            const row0 = Math.max(0, Math.floor((originY - mollBounds[3]) / sy));
            const row1 = Math.min(imgHeight, Math.ceil((originY - mollBounds[1]) / sy));

            if (col1 <= col0 || row1 <= row0) continue;

            const rasters = await image.readRasters({
                window: [col0, row0, col1, row1],
                interleave: false,
            });
            const band0 = rasters[0];
            const width = col1 - col0;
            const height = row1 - row0;

            const x0 = originX + col0 * sx;
            const y0 = originY - row0 * sy;
            const nodata = image.getGDALNoData();

            const dtypeMap = {
                Uint8Array: "uint8",
                Int8Array: "int8",
                Uint16Array: "uint16",
                Int16Array: "int16",
                Uint32Array: "uint32",
                Float32Array: "float32",
            };
            const dtypeStr = dtypeMap[band0.constructor.name] || "float32";

            log(`[ghsl_built] Clipping ${tileId}: ${width}x${height} px (${dtypeStr}) at (${x0}, ${y0})`);
            setStatus(`Bear is baking ${tileId} (${width} × ${height} px) into a GeoTIFF...`);

            pyodide.globals.set("_raster_buf", band0);
            const outName = `ghs_built_s_${year}_${tileId}.tif`;
            pyodide.globals.get("write_ghsl_mollweide_tif")(
                outName,
                JSON.stringify([height, width]),
                dtypeStr,
                x0,
                y0,
                sx,
                sy,
                nodata
            );
            written++;
        }

        return written;
    },
};