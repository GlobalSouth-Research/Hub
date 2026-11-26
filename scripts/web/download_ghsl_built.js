// Free CORS relays for fetching JRC's official regional zip tiles directly in the browser
const CORS_RELAYS = [
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

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

const PY_GHSL_CLIP = `
import zipfile, os, numpy as np, tifffile

def extract_and_clip_ghsl(zip_fn, tif_inside, out_fn, minx, miny, maxx, maxy):
    with zipfile.ZipFile(zip_fn, "r") as zf:
        zf.extract(tif_inside, ".")
    os.remove(zip_fn)

    with tifffile.TiffFile(tif_inside) as tf:
        page = tf.pages[0]
        arr = page.asarray()
        tags = page.tags
        # ModelPixelScaleTag (33550) & ModelTiepointTag (33922)
        sx, sy, _ = tags[33550].value
        _, _, _, origin_x, origin_y, _ = tags[33922].value
        nodata = tags[42113].value if 42113 in tags else None

    os.remove(tif_inside)

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
        1024, 0, 1, 1,        # Projected
        1025, 0, 1, 1,        # PixelIsArea
        3072, 0, 1, 54009,    # ESRI:54009 World Mollweide
        3076, 0, 1, 9001,     # Metres
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

async function fetchViaCorsRelay(targetUrl, log) {
    let lastErr = null;
    for (const makeRelay of CORS_RELAYS) {
        const relayUrl = makeRelay(targetUrl);
        try {
            log(`[ghsl_built] Fetching via CORS relay:`, relayUrl);
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
        pyodide.runPython(PY_GHSL_CLIP);
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

            setStatus(`Bear is downloading JRC tile ${tileId} (${year})...`);
            const zipBytes = await fetchViaCorsRelay(jrcUrl, log);
            log(`[ghsl_built] Downloaded ${baseName}.zip (${(zipBytes.byteLength / (1024 * 1024)).toFixed(2)} MB)`);

            setStatus(`Bear is unzipping & clipping ${tileId} to your AOI...`);
            const zipFn = `${baseName}.zip`;
            const tifInside = `${baseName}.tif`;
            const outFn = `ghs_built_s_${year}_${tileId}.tif`;

            pyodide.FS.writeFile(zipFn, zipBytes);
            const ok = pyodide.globals.get("extract_and_clip_ghsl")(
                zipFn,
                tifInside,
                outFn,
                mollBounds[0],
                mollBounds[1],
                mollBounds[2],
                mollBounds[3]
            );
            if (ok) written++;
        }

        return written;
    },
};