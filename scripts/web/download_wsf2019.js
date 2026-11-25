const DLR_WSF_WMS_URL = "https://geoservice.dlr.de/eoc/oseo/wms";

export const wsf2019Plugin = {
    id: "wsf2015",
    description: "Streams World Settlement Footprint (WSF) 2019 (10m) from DLR OGC WMS into your browser.",
    bundleName: "wsf2019_tiffs.zip",
    controlsHTML: `
        <div class="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
            <strong>WSF 2019 (10m):</strong> Human settlement extent derived from  Sentinel-1 & Sentinel-2 via DLR OSEO WMS.
        </div>
    `,

    async run({ pyodide, bounds, log, setStatus }) {
        const [minx, miny, maxx, maxy] = bounds;

        const centerLatRad = (((miny + maxy) / 2) * Math.PI) / 180;
        const resDegLat = 10 / 111320;
        const resDegLon = 10 / (111320 * Math.cos(centerLatRad));

        const width = Math.max(1, Math.round((maxx - minx) / resDegLon));
        const height = Math.max(1, Math.round((maxy - miny) / resDegLat));

        const snappedMaxX = minx + width * resDegLon;
        const snappedMinY = maxy - height * resDegLat;

        const params = new URLSearchParams({
            SERVICE: "WMS",
            VERSION: "1.1.1",
            REQUEST: "GetMap",
            LAYERS: "WSF_2019",
            STYLES: "",
            SRS: "EPSG:4326",
            BBOX: `${minx},${snappedMinY},${snappedMaxX},${maxy}`,
            WIDTH: String(width),
            HEIGHT: String(height),
            FORMAT: "image/geotiff",
        });

        const wmsUrl = `${DLR_WSF_WMS_URL}?${params.toString()}`;
        log(`[wsf2015] Requesting ${width}x${height} px GeoTIFF:`, wmsUrl);
        setStatus(`Bear is fetching WSF 2019 (${width} × ${height} px) from DLR...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        let resp;
        try {
            resp = await fetch(wmsUrl, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!resp.ok) {
            throw new Error(`DLR WMS request failed (HTTP ${resp.status})`);
        }
        const contentType = resp.headers.get("content-type") || "";
        if (!contentType.includes("tiff")) {
            const errText = await resp.text();
            throw new Error(`DLR WMS returned unexpected response (${contentType}): ${errText}`);
        }

        const tiffBytes = new Uint8Array(await resp.arrayBuffer());
        pyodide.FS.writeFile("wsf2015.tif", tiffBytes);
        pyodide.runPython(`outputs.append("wsf2019.tif")`);
        log(`[wsf2015] Saved wsf2019.tif (${(tiffBytes.byteLength / 1024).toFixed(1)} KB)`);

        return 1;
    },
};