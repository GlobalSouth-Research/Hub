import * as zarr from "https://esm.sh/zarrita";

const STORE_URL = "https://data.source.coop/tessera/tessera/zarr/v1.1-dclimate";

const PY_TESSERA_SETUP = `
def add_tessera_zone(zone, emb_shape, layout, sc_shape, crs, year):
    name = "utm%02d" % int(zone)
    e = np.frombuffer(_emb.to_bytes(), dtype=np.int8).reshape(json.loads(emb_shape))
    if layout == "HWB":
        e = np.transpose(e, (2, 0, 1))
    s = np.frombuffer(_sc.to_bytes(), dtype=np.float32).reshape(json.loads(sc_shape))
    xs = np.frombuffer(_xs.to_bytes(), dtype=np.float64).copy()
    ys = np.frombuffer(_ys.to_bytes(), dtype=np.float64).copy()

    if len(ys) > 1 and ys[0] < ys[-1]:
        e = e[:, ::-1, :]
        s = s[::-1, :]
        ys = ys[::-1]

    sx = abs((xs[-1] - xs[0]) / (len(xs) - 1)) if len(xs) > 1 else 10.0
    sy = abs((ys[0] - ys[-1]) / (len(ys) - 1)) if len(ys) > 1 else 10.0

    epsg = int(str(crs).split(":")[1])
    ys_geo = ys
    if 32601 <= epsg <= 32660 and ys.mean() < 0:
        epsg += 100
        ys_geo = ys + 10_000_000.0
    x0 = float(xs[0] - sx / 2)
    y0 = float(ys_geo[0] + sy / 2)

    valid = np.isfinite(s)
    scale = np.where(valid, s, np.float32("nan")).astype(np.float32)
    data = np.ascontiguousarray(e.astype(np.float32) * scale[None, :, :])

    geokeys = (
        1, 1, 0, 4,
        1024, 0, 1, 1,
        1025, 0, 1, 1,
        3072, 0, 1, epsg,
        3076, 0, 1, 9001,
    )
    extratags = [
        (33550, "d", 3, (float(sx), float(sy), 0.0), True),
        (33922, "d", 6, (0.0, 0.0, 0.0, x0, y0, 0.0), True),
        (34735, "H", len(geokeys), geokeys, True),
        (42113, "s", 0, "nan", True),
    ]

    fn = "tessera_%s_%d.tif" % (name, int(year))
    kw = dict(photometric="minisblack", planarconfig="separate", extratags=extratags)
    try:
        tifffile.imwrite(fn, data, compression="zlib", **kw)
    except Exception as ex:
        print("zlib compression failed (%s); writing uncompressed" % ex)
        tifffile.imwrite(fn, data, **kw)
    outputs.append(fn)
    print("%s: EPSG:%d, %d bands, %dx%d px, origin (%.1f, %.1f), pixel %.2f x %.2f" % (
        name, epsg, data.shape[0], data.shape[2], data.shape[1], x0, y0, sx, sy))
`;

function registerNumcodecs() {
    const make = (url, cfg) => async () => {
        const mod = (await import(url)).default;
        return {
            kind: "bytes_to_bytes",
            fromConfig: () => {
                const c = mod.fromConfig(cfg);
                return { encode: async (d) => c.encode(d), decode: async (d) => c.decode(d) };
            },
        };
    };
    zarr.registry.set("blosc", make("https://esm.sh/numcodecs/blosc", { clevel: 5, cname: "lz4", shuffle: 1, blocksize: 0 }));
    zarr.registry.set("zstd", make("https://esm.sh/numcodecs/zstd", { level: 1 }));
}

const zoneOf = (lon) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));

async function openArray(loc, name) {
    return zarr.open(loc.resolve(name), { kind: "array" });
}

async function readCoord(groupLoc, names) {
    for (const n of names) {
        try {
            const arr = await openArray(groupLoc, n);
            const r = await zarr.get(arr);
            return r.data;
        } catch (e) { /* try next name */ }
    }
    throw new Error("None of these coordinate arrays exist: " + names.join(", "));
}

function indexRange(values, lo, hi) {
    let i0 = -1, i1 = -1;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v >= lo && v <= hi) { if (i0 < 0) i0 = i; i1 = i; }
    }
    return i0 < 0 ? null : [i0, i1 + 1];
}

async function readZone(pyodide, store, zone, year, lonLatBounds, log, setStatus) {
    const zname = "utm" + String(zone).padStart(2, "0");
    const groupLoc = zarr.root(store).resolve(zname);
    const grp = await zarr.open(groupLoc, { kind: "group" });
    log(`[${zname}] group attrs:`, grp.attrs);

    const crs = grp.attrs["proj:code"];
    if (!crs) throw new Error(`${zname}: no 'proj:code' attribute found`);

    const zl = -180 + 6 * (zone - 1), zr = zl + 6;
    const [bx0, by0, bx1, by1] = lonLatBounds;
    const cl = Math.max(bx0, zl), cr = Math.min(bx1, zr - 1e-9);
    const b = JSON.parse(pyodide.globals.get("bounds_in_crs")(cl, by0, cr, by1, crs));

    const xs = await readCoord(groupLoc, ["easting", "x"]);
    const ys = await readCoord(groupLoc, ["northing", "y"]);
    const times = Array.from(await readCoord(groupLoc, ["time"]), Number);
    const ti = times.indexOf(year);
    if (ti < 0) throw new Error(`Year ${year} not in time axis: ${times.join(", ")}`);

    const xr = indexRange(xs, b[0], b[2]);
    const yr = indexRange(ys, b[1], b[3]);
    if (!xr || !yr) return null;
    const h = yr[1] - yr[0], w = xr[1] - xr[0];

    const emb = await openArray(groupLoc, "embeddings");
    const sc = await openArray(groupLoc, "scales");
    const ysl = zarr.slice(yr[0], yr[1]);
    const xsl = zarr.slice(xr[0], xr[1]);

    let embSel, layout;
    if (emb.shape.length === 4 && emb.shape[1] === 128) { embSel = [ti, null, ysl, xsl]; layout = "BHW"; }
    else if (emb.shape.length === 4 && emb.shape[3] === 128) { embSel = [ti, ysl, xsl, null]; layout = "HWB"; }
    else throw new Error("Unexpected embeddings shape " + JSON.stringify(emb.shape));

    let scSel;
    if (sc.shape.length === 3) scSel = [ti, ysl, xsl];
    else if (sc.shape.length === 2) scSel = [ysl, xsl];
    else throw new Error("Unexpected scales shape " + JSON.stringify(sc.shape));

    setStatus(`Bear is chewing ${zname} (${w} x ${h} px)...`);
    const embChunk = await zarr.get(emb, embSel);
    const scChunk = await zarr.get(sc, scSel);

    return {
        zone, crs, layout, year,
        embData: embChunk.data, embShape: embChunk.shape,
        scData: scChunk.data, scShape: scChunk.shape,
        xs: Float64Array.from(xs.slice(xr[0], xr[1])),
        ys: Float64Array.from(ys.slice(yr[0], yr[1])),
    };
}

export const tesseraPlugin = {
    id: "tessera",
    description: "Streams TESSERA Zarr data straight into your browser.",
    bundleName: "tessera_tiffs.zip",
    controlsHTML: `
        <label for="tessera-year" class="block text-sm font-medium text-gray-700 mb-2">Year</label>
        <input id="tessera-year" type="number" value="2024" min="2017" max="2025"
               class="w-full border border-gray-300 rounded-lg p-2.5 bg-white">
    `,

    async init(pyodide) {
        pyodide.runPython(PY_TESSERA_SETUP);
        registerNumcodecs();
    },

    async run({ pyodide, bounds, log, setStatus }) {
        const year = parseInt(document.getElementById("tessera-year").value, 10);
        const zone2name = (z) => "utm" + String(z).padStart(2, "0");

        setStatus("Bear is knocking on Source Coop's door...");
        let store = new zarr.FetchStore(STORE_URL);
        if (typeof zarr.tryWithConsolidatedMetadata === "function") {
            store = await zarr.tryWithConsolidatedMetadata(store);
        }

        const zones = [];
        for (let z = zoneOf(bounds[0]); z <= zoneOf(bounds[2]); z++) zones.push(z);
        log("UTM zones:", zones);

        let written = 0;
        for (const z of zones) {
            const r = await readZone(pyodide, store, z, year, bounds, log, setStatus);
            if (!r) continue;
            pyodide.globals.set("_emb", r.embData);
            pyodide.globals.set("_sc", r.scData);
            pyodide.globals.set("_xs", r.xs);
            pyodide.globals.set("_ys", r.ys);
            setStatus(`Bear is baking ${zone2name(r.zone)} into a GeoTIFF...`);
            pyodide.globals.get("add_tessera_zone")(
                r.zone, JSON.stringify(r.embShape), r.layout,
                JSON.stringify(r.scShape), r.crs, r.year
            );
            written++;
        }
        return written;
    },
};