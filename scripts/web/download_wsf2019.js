const CORS_RELAYS = [
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const PY_WSF_CLIP = `
import os, numpy as np, tifffile

def clip_wsf_geotiff(in_fn, out_fn, minx, miny, maxx, maxy):
    with tifffile.TiffFile(in_fn) as tf:
        page = tf.pages[0]
        arr = page.asarray()
        tags = page.tags
        sx, sy, _ = tags[33550].value
        _, _, _, origin_x, origin_y, _ = tags[33922].value
        nodata = tags[42113].value if 42113 in tags else None

    os.remove(in_fn)

    h, w = arr.shape[:2]
    col0 = max(0, int(np.floor((minx - origin_x) / sx)))
    col1 = min(w, int(np.ceil((maxx - origin_x) / sx)))
    row0 = max(0, int(np.floor((origin_y - maxy) / sy)))
    row1 = min(h, int(np.ceil((origin_y - miny) / sy)))

    if col1 <= col0 or row1 <= row0:
        return False

    clipped = np.ascontiguousarray(arr[row0:row1, col0:col1])
    x0 = float(origin_x + col0 * sx)
    y0 = float(origin_y - row0 * sy)

    geokeys = (
        1, 1, 0, 4,
        1024, 0, 1, 2,        # Geographic (EPSG:4326)
        1025, 0, 1, 1,        # PixelIsArea
        2048, 0, 1, 4326,     # WGS 84
        2054, 0, 1, 9102,     # Angular degree
    )
    extratags = [
        (33550, "d", 3, (float(sx), float(sy), 0.0), True),
        (33922, "d", 6, (0.0, 0.0, 0.0, x0, y0, 0.0), True),
        (34735, "H", len(geokeys), geokeys, True),
    ]
    if nodata is not None:
        extratags.append((42113, "s", 0, str(nodata), True))

    tifffile.imwrite(out_fn, clipped, photometric="minisblack", extratags=extratags, compression="zlib")
    outputs.append(out_fn)
    print(f"Clipped {out_fn}: {clipped.shape[1]}x{clipped.shape[0]} px")
    return True
`;

function getWsf2019TileIds(bounds) {
    const [minx, miny, maxx, maxy] = bounds;
    const lonStart = Math.floor(minx / 2) * 2;
    const lonEnd = Math.floor((maxx - 1e-9) / 2) * 2;
    const latStart = Math.floor(miny / 2) * 2;
    const latEnd = Math.floor((maxy - 1e-9) / 2) * 2;

    const tiles = [];
    for (let lon = lonStart; lon <= lonEnd; lon += 2) {
        for (let lat = latStart; lat <= latEnd; lat += 2) {
            tiles.push(`WSF2019_${lon}_${lat}`);
        }
    }
    return tiles;
}

async function fetchViaCorsRelay(targetUrl, log) {
    let lastErr = null;
    for (const makeRelay of CORS_RELAYS) {
        const relayUrl = makeRelay(targetUrl);
        try {
            log(`[wsf2019] Fetching via CORS relay:`, relayUrl);
            const resp = await fetch(relayUrl);
            if (resp.ok) {
                return new Uint8Array(await resp.arrayBuffer());
            }
            lastErr = new Error(`Relay HTTP ${resp.status}`);
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(`All CORS relays failed for ${targetUrl}: ${lastErr?.message || lastErr}`);
}

export const wsf2019Plugin = {
    id: "wsf2019",
    description: "Streams raw World Settlement Footprint (WSF) 2019 (10m) GeoTIFF from DLR.",
    bundleName: "wsf2019_tiffs.zip",
    controlsHTML: `
        <div class="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
            <strong>WSF 2019 (10m):</strong> Raw binary human settlement mask (<code>255</code> = settlement, <code>0</code> = non-settlement) derived from Landsat-8 & Sentinel-1.
        </div>
    `,

    async init(pyodide) {
        pyodide.runPython(PY_WSF_CLIP);
    },

    async run({ pyodide, bounds, log, setStatus }) {
        const tileIds = getWsf2019TileIds(bounds);
        log(`[wsf2019] Intersecting 2°x2° tile(s):`, tileIds);

        let written = 0;
        for (const tileId of tileIds) {
            const tileUrl = `https://download.geoservice.dlr.de/WSF2019/files/${tileId}/${tileId}.tif`;
            setStatus(`Bear is downloading WSF 2019 tile ${tileId}...`);
            const rawBytes = await fetchViaCorsRelay(tileUrl, log);
            log(`[wsf2019] Downloaded ${tileId}.tif (${(rawBytes.byteLength / (1024 * 1024)).toFixed(2)} MB)`);

            setStatus(`Bear is clipping ${tileId} to your AOI...`);
            const tmpFn = `_tmp_${tileId}.tif`;
            const outFn = `${tileId}.tif`;

            pyodide.FS.writeFile(tmpFn, rawBytes);
            const ok = pyodide.globals.get("clip_wsf_geotiff")(
                tmpFn,
                outFn,
                bounds[0],
                bounds[1],
                bounds[2],
                bounds[3]
            );
            if (ok) written++;
        }

        return written;
    },
};