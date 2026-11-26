import * as GeoTIFF from "https://esm.sh/geotiff@2.1.3";

const viaProxy = (url) => `/proxy?url=${encodeURIComponent(url)}`;

function getWsf2015TileIds(bounds) {
    const [minx, miny, maxx, maxy] = bounds;
    const lonStart = Math.floor(minx / 2) * 2;
    const lonEnd = Math.floor((maxx - 1e-9) / 2) * 2;
    const latStart = Math.floor(miny / 2) * 2;
    const latEnd = Math.floor((maxy - 1e-9) / 2) * 2;

    const tiles = [];
    for (let lon = lonStart; lon <= lonEnd; lon += 2) {
        for (let lat = latStart; lat <= latEnd; lat += 2) {
            tiles.push(`WSF2015_v2_${lon}_${lat}`);
        }
    }
    return tiles;
}

export const wsf2015Plugin = {
    id: "wsf2015",
    description: "Streams raw World Settlement Footprint (WSF) 2015 (10m) GeoTIFF from DLR.",
    bundleName: "wsf2015_tiffs.zip",
    controlsHTML: `
        <div class="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
            <strong>WSF 2015 (10m):</strong> Raw binary human settlement mask (<code>255</code> = settlement, <code>0</code> = non-settlement) derived from Landsat-8 & Sentinel-1.
        </div>
    `,

    async run({ pyodide, bounds, log, setStatus }) {
        const tileIds = getWsf2015TileIds(bounds);
        log(`[wsf2015] Intersecting 2°x2° tile(s):`, tileIds);

        let written = 0;
        for (const tileId of tileIds) {
            const rawUrl = `https://download.geoservice.dlr.de/WSF2015/files/${tileId}/${tileId}.tif`;
            log(`[wsf2015] Streaming COG window from:`, rawUrl);
            setStatus(`Bear is nibbling WSF 2015 tile ${tileId}...`);

            const tiff = await GeoTIFF.fromUrl(viaProxy(rawUrl));
            const image = await tiff.getImage();

            const imgWidth = image.getWidth();
            const imgHeight = image.getHeight();
            const [resX, resY] = image.getResolution();
            const sx = Math.abs(resX);
            const sy = Math.abs(resY);
            const [originX, originY] = image.getOrigin();

            const col0 = Math.max(0, Math.floor((bounds[0] - originX) / sx));
            const col1 = Math.min(imgWidth, Math.ceil((bounds[2] - originX) / sx));
            const row0 = Math.max(0, Math.floor((originY - bounds[3]) / sy));
            const row1 = Math.min(imgHeight, Math.ceil((originY - bounds[1]) / sy));

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

            log(`[wsf2015] Clipping ${tileId}: ${width}x${height} px at (${x0}, ${y0})`);
            setStatus(`Bear is baking ${tileId} (${width} × ${height} px) into a GeoTIFF...`);

            pyodide.globals.set("_raster_buf", band0);
            const outName = `${tileId}.tif`;
            pyodide.globals.get("write_geotiff_2d")(
                outName,
                JSON.stringify([height, width]),
                "uint8",
                4326,
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