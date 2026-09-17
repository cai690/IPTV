const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const HOST = "https://app.kanchaozhou.com";
const client = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  validateStatus: (s) => s >= 200 && s < 500,
});
function md5(input) {
  return crypto.createHash("md5").update(String(input)).digest("hex");
}
function randomString(length = 16) {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
function generateDeviceId(length = 32) {
  return crypto.randomBytes(length / 2).toString("hex").toUpperCase();
}
function resolveIndexById(id) {
  const num = Number(id);
  // 原 PHP: list[12 - id]，默认 id=11(综合)，12(民生)
  if (num !== 11 && num !== 12) return 1; // 默认综合(11 => index 1)
  return 12 - num;
}
async function fetchPlayUrl(channelId) {
  const t = Date.now();
  const deviceId = generateDeviceId(32);
  const auth = `${md5(`s0bey8085${t}`)}_${t}_${deviceId}`;
  const random = randomString(16);
  const tmencryptkey = md5(Buffer.from(`${md5(t)}${random}`).toString("base64") + random);
  const res = await client.get(
    `${HOST}/tvradio/Frontapi/tvList?class_id=0&index=1&status=2`,
    {
      headers: {
        Host: "app.kanchaozhou.com",
        authorization: auth,
        tmtimestamp: String(t),
        tmencryptkey,
        tmencrypt: "1",
        tmrandomnum: random,
        lang: "zh-cn",
        "accept-encoding": "gzip",
        "user-agent": "okhttp/3.12.13",
      },
    },
  );
  const data = res && res.data && typeof res.data === "object" ? res.data : {};
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  const idx = resolveIndexById(channelId);
  const row = list[idx];
  const playUrl = row && typeof row.m3u8 === "string" ? row.m3u8.trim() : "";
  if (!playUrl) throw new Error("未获取到可播放地址");
  return playUrl;
}

// 新增：频道背景图配置，自行替换图片链接即可
const CHANNEL_BG_MAP = {
  "11": "https://d.kstore.dev/download/12351/%E6%BD%AE%E5%B7%9E%E7%BB%BC%E5%90%88.png", // 综合频道背景图
  "12": "https://d.kstore.dev/download/12351/%E6%BD%AE%E5%B7%9E%E6%B0%91%E7%94%9F.png" // 民生频道背景图
};

const CHANNELS = [
  { id: "11", name: "综合频道" },
  { id: "12", name: "民生频道" },
];

const RTMP_SECRET = "s0bey8085";
const RTMP_HOST = "live-rtmp-btv.kanchaozhou.com";
const RELAY_ROOT = path.join(os.tmpdir(), "buye-kanchaozhou-hls");
const HLS_TIME = "4";
const HLS_LIST_SIZE = "4";
const RELAY_IDLE_MS = 10 * 60 * 1000;

const relayState = new Map();

function channelDir(channelId) {
  return path.join(RELAY_ROOT, String(channelId));
}

function normalizeChannelId(channelId) {
  const value = String(channelId || "").trim();
  return CHANNELS.some((channel) => channel.id === value) ? value : "11";
}

function relayManifestPath(channelId) {
  return path.join(channelDir(channelId), "index.m3u8");
}

function rewriteRelayManifest(base, channelId, text) {
  const prefix = `${base}/hls/${encodeURIComponent(channelId)}`;
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return `${prefix}/${encodeURIComponent(trimmed)}`;
    })
    .join("\n");
}

function signRtmpUrl(inputUrl) {
  const url = new URL(inputUrl);
  const secret = RTMP_SECRET;
  const stream = String(url.pathname.replace(/^\/live\//i, "")).split(/[?#]/)[0] || "";
  const txTime = String(Math.floor(Date.now() / 1000) + 2 * 3600).toString(16);
  const txSecret = md5(`${secret}${stream}${txTime}`);
  url.search = "";
  url.hash = "";
  url.pathname = `/live/${stream}`;
  url.searchParams.set("txSecret", txSecret);
  url.searchParams.set("txTime", txTime);
  return url.toString();
}

function buildRelayBase(req) {
  const host = String(req.headers?.host || "").trim();
  if (!host) return "";
  const prefix = meta.api.endsWith("/") ? meta.api.slice(0, -1) : meta.api;
  return `${req.protocol || "http"}://${host}${prefix}`;
}

function normalizeSignedRtmp(rawPlayUrl) {
  try {
    const url = new URL(rawPlayUrl);
    if (!/^rtmp:$/.test(url.protocol)) return rawPlayUrl;
    if (!String(url.hostname || "")) return rawPlayUrl;
    return signRtmpUrl(rawPlayUrl);
  } catch {
    return rawPlayUrl;
  }
}

async function waitForRelayManifest(channelId) {
  const target = relayManifestPath(channelId);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(target);
      if (stat.size > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("HLS 转码准备超时，请稍后重试");
}



function killConflictingRelays(dir) {
  try {
    const { execSync } = require("child_process");
    const ps = String(execSync("ps -Ao pid=,command=", { encoding: "utf8" }) || "");
    const target = String(dir || "").trim();
    if (!target) return;
    for (const rawLine of ps.split(/\r?\n/)) {
      const line = String(rawLine || "").trim();
      if (!line || !line.includes("ffmpeg") || !line.includes(target)) continue;
      const match = /^(\d+)/.exec(line);
      const pid = Number(match?.[1]);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {}
}
function ensureRelayDir(channelId) {
  fs.mkdirSync(channelDir(channelId), { recursive: true });
}

function touchRelay(channelId) {
  const session = relayState.get(channelId);
  if (session) session.touchedAt = Date.now();
}

function reapRelays() {
  const now = Date.now();
  for (const [channelId, session] of relayState.entries()) {
    if (session.main && now - session.touchedAt < RELAY_IDLE_MS) continue;
    stopRelay(channelId);
    relayState.delete(channelId);
  }
}

function stopRelay(channelId) {
  const session = relayState.get(channelId);
  if (!session) return;
  session.main = false;
  try { session.process.kill("SIGKILL"); } catch {}
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
}

function startRelay(channelId, signedRtmp) {
  const id = String(channelId);
  let session = relayState.get(id);
  if (session && !session.exited) {
    session.touchedAt = Date.now();
    return session;
  }
  reapRelays();
  const dir = channelDir(id);
  killConflictingRelays(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  ensureRelayDir(id);
  const manifestPath = path.join(dir, "index.m3u8");
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    signedRtmp,
    "-c",
    "copy",
    "-f",
    "hls",
    manifestPath,
    "-hls_time",
    HLS_TIME,
    "-hls_list_size",
    "0",
    "-hls_flags",
    "append_playlist",
  ];
  const child = spawn(process.env.FFMPEG_BIN || "ffmpeg", args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    session && (session.stderr = stderr.slice(-4000));
  });
  child.stdout.on("data", () => {});
  const onExit = () => {
    session && (session.exited = true);
    child.removeAllListeners("error");
  };
  child.on("error", (error) => {
    onExit();
    relayState.get(id) && (relayState.get(id).error = error.message);
  });
  child.on("exit", onExit);
  session = {
    id,
    dir,
    process: child,
    touchedAt: Date.now(),
    exited: false,
    main: true,
    stderr: "",
    error: "",
    manifestPath,
  };
  relayState.set(id, session);
  return session;
}

function serveRelaySegment(channelId, fileName, reply) {
  const safe = path.basename(fileName);
  if (!/\.ts$/i.test(safe)) {
    reply.status(404).send("invalid-segment");
    return;
  }
  const filePath = path.join(channelDir(channelId), safe);
  if (!fs.existsSync(filePath)) {
    reply.status(404).send("missing");
    return;
  }
  const stat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  reply
    .status(200)
    .type("video/mp2t")
    .header("Content-Length", String(stat.size))
    .header("Cache-Control", "public, max-age=30")
    .header("Access-Control-Allow-Origin", "*")
    .header("X-Accel-Buffering", "no")
    .send(buffer);
}

async function waitForRelayManifest(channelId) {
  const target = relayManifestPath(channelId);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(target);
      if (stat.size > 0) return;
    } catch {}
    const session = relayState.get(channelId);
    if (session && session.exited) {
      throw new Error(session.error || session.stderr || "HLS 转码已结束");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("HLS 转码准备超时，请稍后重试");
}

function readRelayManifest(channelId) {
  const target = relayManifestPath(channelId);
  return fs.readFileSync(target, "utf8");
}

const meta = {
  key: "kanchaozhou",
  name: "[直播]看潮州",
  type: 4,
  api: "/video/kanchaozhou",
  searchable: 1,
  quickSearch: 0,
  changeable: 0,
};
module.exports = async (app, opt) => {
  app.get(meta.api, async (req, res) => {
    const { ac, t, ids, wd, play, filter } = req.query;
    try {
      if (play) {
        const rawPlayUrl = await fetchPlayUrl(play);
        const signedPlayUrl = normalizeSignedRtmp(rawPlayUrl);
        let relayReady = false;
        try {
          const session = startRelay(play, signedPlayUrl);
          touchRelay(play);
          await waitForRelayManifest(play);
          relayReady = !session.exited;
        } catch {}
        res.send({
          parse: 0,
          playUrl: "",
          url: relayReady ? `${buildRelayBase(req)}${meta.api}/hls/${encodeURIComponent(play)}/index.m3u8` : "",
          header: { Referer: `${buildRelayBase(req)}${meta.api}/hls/${encodeURIComponent(play)}/index.m3u8` },
        });
        return;
      }
      // 兼容直接当 php 用：/video/kanchaozhou?id=11，必须放在 !ac 之前，
      // 否则 ?id= 会被当作无 ac 的列表请求返回 JSON。
      if (req.query.id) {
        const playId = normalizeChannelId(req.query.id);
        const rawPlayUrl = await fetchPlayUrl(playId);
        const signedPlayUrl = normalizeSignedRtmp(rawPlayUrl);
        const isNative = String(req.query.native || "").trim() === "1";
        if (isNative) {
          res.type("text/plain; charset=utf-8").send(signedPlayUrl);
          return;
        }
        try {
          const session = startRelay(playId, signedPlayUrl);
          touchRelay(playId);
          await waitForRelayManifest(playId);
          res.redirect(`${buildRelayBase(req)}${meta.api}/hls/${encodeURIComponent(playId)}/index.m3u8`);
        } catch (error) {
          res.redirect(signedPlayUrl);
        }
        return;
      }
      if (wd) {
        const kw = String(wd).trim();
        const list = CHANNELS.filter((c) => c.name.includes(kw) || c.id === kw).map((c) => ({
          vod_id: c.id,
          vod_name: c.name,
          vod_pic: CHANNEL_BG_MAP[c.id], // 赋值对应频道背景
          vod_remarks: "直播",
        }));
        res.send({ list, page: 1, pagecount: 1, limit: list.length || 2, total: list.length });
        return;
      }
      if (!ac) {
        const list = CHANNELS.map((c) => ({
          vod_id: c.id,
          vod_name: c.name,
          vod_pic: CHANNEL_BG_MAP[c.id], // 首页频道列表背景
          vod_remarks: "直播",
        }));
        res.send({
          class: [{ type_id: "live", type_name: "潮州直播" }],
          list: String(filter) === "false" ? list : [],
        });
        return;
      }
      if (ac === "detail") {
        if (t) {
          const list = CHANNELS.map((c) => ({
            vod_id: c.id,
            vod_name: c.name,
            vod_pic: CHANNEL_BG_MAP[c.id], // 分类详情列表背景
            vod_remarks: "直播",
          }));
          res.send({ list, page: 1, pagecount: 1, limit: list.length, total: list.length });
          return;
        }
        if (ids) {
          const id = String(ids).split(",")[0].trim() || "11";
          const ch = CHANNELS.find((c) => c.id === id) || CHANNELS[0];
          res.send({
            list: [{
              vod_id: ch.id,
              vod_name: ch.name,
              vod_pic: CHANNEL_BG_MAP[ch.id], // 单频道详情背景
              vod_remarks: "直播",
              vod_content: "看潮州直播源",
              vod_play_from: "看潮州",
              vod_play_url: `${ch.name}$${ch.id}`,
            }],
          });
          return;
        }
      }
      res.send(req.query);
    } catch (err) {
      res.status(500).json({
        code: 500,
        msg: err instanceof Error ? err.message : "获取播放地址失败",
      });
    }
  });

  app.get(`${meta.api}/hls/:channelId/index.m3u8`, async (req, reply) => {
    try {
      const channelId = normalizeChannelId(req.params?.channelId);
      const rawPlayUrl = await fetchPlayUrl(channelId);
      const signedPlayUrl = normalizeSignedRtmp(rawPlayUrl);
      const session = startRelay(channelId, signedPlayUrl);
      touchRelay(channelId);
      await waitForRelayManifest(channelId);
      const manifest = readRelayManifest(channelId);
      const base = buildRelayBase(req) || `${req.protocol || "http"}://${req.headers.host || "localhost"}${req.baseUrl || ""}`;
      reply
        .status(200)
        .type('application/vnd.apple.mpegurl; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('Access-Control-Allow-Origin', '*')
        .header('X-Accel-Buffering', 'no')
        .send(rewriteRelayManifest(base, channelId, manifest));
    } catch (error) {
      reply.status(502).send(error instanceof Error ? error.message : "HLS 清单不可用");
    }
  });

  app.get(`${meta.api}/hls/:channelId/*`, async (req, reply) => {
    try {
      const channelId = normalizeChannelId(req.params?.channelId);
      const rawPlayUrl = await fetchPlayUrl(channelId);
      const signedPlayUrl = normalizeSignedRtmp(rawPlayUrl);
      const session = startRelay(channelId, signedPlayUrl);
      touchRelay(channelId);
      const fileName = String(req.params?.["*"] || "").trim();
      if (!fileName) {
        reply.status(404).send("missing");
        return;
      }
      serveRelaySegment(channelId, fileName, reply);
    } catch (error) {
      reply.status(502).send(error instanceof Error ? error.message : "HLS 切片不可用");
    }
  });

  // 标准 M3U 输出：两个频道指向播放代理端点，由 ?id= 实时换取短效 m3u8。
  app.get(`${meta.api}/m3u`, (req, res) => {
    const base = `${req.protocol || "http"}://${req.headers.host || "localhost"}`;
    const lines = ["#EXTM3U"];
    for (const c of CHANNELS) {
      const logo = CHANNEL_BG_MAP[c.id] || "";
      const attrs = [
        `tvg-id="${c.id}"`,
        `tvg-name="${c.name}"`,
        `tvg-logo="${logo}"`,
        `group-title="潮州直播"`,
      ].join(" ");
      lines.push(`#EXTINF:-1 ${attrs},${c.name}`);
      const native = String(req.query?.native || "").trim() === "1";
      if (native) {
        lines.push(`${base}${meta.api}?id=${c.id}&native=1`);
      } else {
        lines.push(`${base}${meta.api}/hls/${c.id}/index.m3u8`);
      }
    }
    res.type("text/plain; charset=utf-8").send(lines.join("\n"));
  });



  app.get(`${meta.api}/_debug/m3u`, async (req, reply) => {
    try {
      const raw = await fetchPlayUrl("11");
      const signed = normalizeSignedRtmp(raw);
      const session = startRelay("11", signed);
      touchRelay("11");
      await waitForRelayManifest("11");
      const text = readRelayManifest("11");
      const base = buildRelayBase(req) || `${req.protocol || "http"}://${req.headers.host || "localhost"}${req.baseUrl || ""}`;
      reply.type("text/plain; charset=utf-8").send(rewriteRelayManifest(base, "11", text));
    } catch (error) {
      reply.status(502).send(String(error instanceof Error ? error.message : error));
    }
  });

  app.get(`${meta.api}/_debug/seg`, async (req, reply) => {
    try {
      const filePath = path.join(channelDir("11"), "index21.ts");
      if (!fs.existsSync(filePath)) return reply.status(404).send("missing-debug");
      const stat = fs.statSync(filePath);
      reply
        .status(200)
        .type("video/mp2t")
        .header("Content-Length", String(stat.size))
        .header("Cache-Control", "public, max-age=30")
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Accel-Buffering", "no")
        .send(fs.readFileSync(filePath));
    } catch (error) {
      reply.status(502).send(String(error instanceof Error ? error.message : error));
    }
  });
  app.get(`${meta.api}/status`, async (req, res) => {
    const now = Date.now();
    const out = [];
    for (const c of CHANNELS) {
      const id = c.id;
      const session = relayState.get(id);
      out.push({
        id,
        name: c.name,
        ffmpeg: session
          ? {
              exited: Boolean(session?.exited),
              touchedAt: Number(session?.touchedAt || 0),
              ageMs: now - Number(session?.touchedAt || 0),
              error: String(session?.error || ""),
            }
          : null,
      });
    }
    res.send({ channels: out, relayRoot: RELAY_ROOT });
  });

  app.addHook("onClose", async () => {
    for (const channelId of relayState.keys()) stopRelay(channelId);
    relayState.clear();
  });

  opt.sites.push(meta);
};
