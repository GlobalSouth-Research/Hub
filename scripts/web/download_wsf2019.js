import * as GeoTIFF from "https://esm.sh/geotiff@2.1.3";

const viaProxy = (url) => `/proxy?url=${encodeURIComponent(url)}`;

function getWsf2019GridCoords(bounds) {
    const [minx, miny, maxx, maxy] = bounds;
    const lonStart = Math.floor(minx / 2) * 2;
    const lonEnd = Math.floor((maxx - 1e-9) / 2) * 2;
    const latStart = Math.floor(miny / 2) * 2;
    const latEnd = Math.floor((maxy - 1e-9) / 2) * 2;

    const coords = [];
    for (let lon = lonStart; lon <= lonEnd; lon += 2) {
        for (let lat = latStart; lat <= latEnd; lat += 2) {
            coords.push({ lon, lat });
        }
    }
    return coords;
}

async function openWsf2019Tile(lon, lat, log) {
    const candidates = [
        {
            tileId: `WSF2019_v1_${lon}_${lat}`,
            url: `https://download.geoservice.dlr.de/WSF2019/files/WSF2019_v1_${lon}_${lat}.tif`,
        },
        {
            tileId: `WSF2019_${lon}_${lat}`,
            url: `https://download.geoservice.dlr.de/WSF2019/files/WSF2019_${lon}_${lat}.tif`,
        },
    ];

    let lastErr = null;
    for (const { tileId, url } of candidates) {
        try {
            log(`[wsf2019] Probing COG:`, url);
            const tiff = await GeoTIFF.fromUrl(viaProxy(url));
            const image = await tiff.getImage();
            return { tileId, image };
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(`Could not open WSF 2019 tile (${lon}, ${lat}): ${lastErr?.message || lastErr}`);
}

export const wsf2019Plugin = {
    id: "wsf2019",
    description: "Streams raw World Settlement Footprint (WSF) 2019 (10m) GeoTIFF from DLR.",
    bundleName: "wsf2019_tiffs.zip",
    controlsHTML: `
        <div class="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
            <strong>WSF 2019 (10m):</strong> Raw binary human settlement mask (<code>255</code> = settlement, <code>0</code> = non-settlement) derived from Sentinel-1 &amp; Sentinel-2.
        </div>
    `,

    async run({ pyodide, bounds, log, setStatus }) {
        const coords = getWsf2019GridCoords(bounds);
        log(`[wsf2019] Intersecting 2°x2° grid cell(s):`, coords);

        let written = 0;
        for (const { lon, lat } of coords) {
            setStatus(`Bear is nibbling WSF 2019 tile (${lon}, ${lat})...`);
            const { tileId, image } = await openWsf2019Tile(lon, lat, log);

            const [imgMinX, imgMinY, imgMaxX, imgMaxY] = image.getBoundingBox();
            const clipBox = [
                Math.max(bounds[0], imgMinX),
                Math.max(bounds[1], imgMinY),
                Math.min(bounds[2], imgMaxX),
                Math.min(bounds[3], imgMaxY),
            ];
            if (clipBox[0] >= clipBox[2] || clipBox[1] >= clipBox[3]) continue;

            const rasters = await image.readRasters({
                bbox: clipBox,
                interleave: false,
            });
            const band0 = rasters[0];
            const width = rasters.width;
            const height = rasters.height;
            if (!width || !height) continue;

            const [resX, resY] = image.getResolution();
            const sx = Math.abs(resX);
            const sy = Math.abs(resY);
            const [originX, originY] = image.getOrigin();

            const col0 = Math.max(0, Math.floor((clipBox[0] - originX) / sx));
            const row0 = Math.max(0, Math.floor((originY - clipBox[3]) / sy));
            const x0 = originX + col0 * sx;
            const y0 = originY - row0 * sy;
            const nodata = image.getGDALNoData();

            log(`[wsf2019] Clipping ${tileId}: ${width}x${height} px`);
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