import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDatabasePath, getState, getStates, setState } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
const instrumentsDir = path.join(rootDir, "data", "instruments");

dotenv.config({ path: envPath });
fs.mkdirSync(instrumentsDir, { recursive: true });

const app = express();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const indiaTimeZone = "Asia/Calcutta";
const credentialKeys = {
  consumerKey: "credential.consumerKey",
  mobileNumber: "credential.mobileNumber",
  ucc: "credential.ucc",
  mpin: "credential.mpin",
};
const sessionKeys = {
  viewToken: "session.viewToken",
  viewSid: "session.viewSid",
  sessionToken: "session.sessionToken",
  sessionSid: "session.sessionSid",
  baseUrl: "session.baseUrl",
  authenticatedAt: "session.authenticatedAt",
  authDate: "session.authDate",
};
const instrumentKeys = {
  lastSyncDate: "instrument.lastSyncDate",
  lastSyncAt: "instrument.lastSyncAt",
  lastSyncPath: "instrument.lastSyncPath",
  lastSyncCount: "instrument.lastSyncCount",
};

app.use(cors());
app.use(express.json());

app.get("/api/settings", async (req, res) => {
  try {
    const settings = getStoredCredentials();
    res.json({
      ...settings,
      hasCredentials: hasStoredCredentials(settings),
      dbPath: getDatabasePath(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const next = {
      consumerKey: String(req.body?.consumerKey ?? "").trim(),
      mobileNumber: String(req.body?.mobileNumber ?? "").trim(),
      ucc: String(req.body?.ucc ?? "").trim(),
      mpin: String(req.body?.mpin ?? "").trim(),
    };

    if (!hasStoredCredentials(next)) {
      res.status(400).json({ error: "consumerKey, mobileNumber, ucc, and mpin are required." });
      return;
    }

    setState(credentialKeys.consumerKey, next.consumerKey);
    setState(credentialKeys.mobileNumber, next.mobileNumber);
    setState(credentialKeys.ucc, next.ucc);
    setState(credentialKeys.mpin, next.mpin);

    res.json({
      ...next,
      hasCredentials: true,
      dbPath: getDatabasePath(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/auth/status", async (req, res) => {
  try {
    res.json(getSessionState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/instruments/status", async (req, res) => {
  try {
    res.json(getInstrumentCacheStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/instruments/refresh", async (req, res) => {
  try {
    ensureCurrentSession();
    const result = await syncInstrumentMaster({ force: true });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/instruments/search", async (req, res) => {
  try {
    const query = String(req.query.q ?? "").trim().toLowerCase();
    const exchangeSegment = String(req.query.exchangeSegment ?? "").trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const cache = readInstrumentCache();

    if (!query) {
      res.json({ data: [], status: getInstrumentCacheStatus() });
      return;
    }

    const rows = cache?.records ?? [];
    const matches = rows
      .filter((row) => !exchangeSegment || row.exchangeSegment === exchangeSegment)
      .filter((row) =>
        [row.exchangeSegment, row.exchangeToken, row.tradingSymbol, row.instrumentName, row.displaySymbol]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query)),
      )
      .slice(0, limit);

    res.json({ data: matches, status: getInstrumentCacheStatus() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { totp } = req.body ?? {};
    if (!totp) {
      res.status(400).json({ error: "TOTP is required." });
      return;
    }

    const config = requireCredentials();

    const viewResponse = await kotakFetch("https://mis.kotaksecurities.com/login/1.0/tradeApiLogin", {
      method: "POST",
      headers: {
        Authorization: config.consumerKey,
        "neo-fin-key": "neotradeapi",
      },
      body: JSON.stringify({
        mobileNumber: config.mobileNumber,
        ucc: config.ucc,
        totp: String(totp),
      }),
      contentType: "application/json",
    });

    const viewToken = viewResponse?.data?.token;
    const viewSid = viewResponse?.data?.sid;

    if (!viewToken || !viewSid) {
      throw new Error("Kotak login did not return the view token or SID.");
    }

    const sessionResponse = await kotakFetch("https://mis.kotaksecurities.com/login/1.0/tradeApiValidate", {
      method: "POST",
      headers: {
        Authorization: config.consumerKey,
        "neo-fin-key": "neotradeapi",
        sid: viewSid,
        Auth: viewToken,
      },
      body: JSON.stringify({ mpin: config.mpin }),
      contentType: "application/json",
    });

    const sessionToken = sessionResponse?.data?.token;
    const sessionSid = sessionResponse?.data?.sid;
    const baseUrl = normalizeBaseUrl(sessionResponse?.data?.baseUrl);

    if (!sessionToken || !sessionSid || !baseUrl) {
      throw new Error("Kotak session validation did not return the session token, SID, or base URL.");
    }

    persistRuntimeSession({
      [sessionKeys.viewToken]: viewToken,
      [sessionKeys.viewSid]: viewSid,
      [sessionKeys.sessionToken]: sessionToken,
      [sessionKeys.sessionSid]: sessionSid,
      [sessionKeys.baseUrl]: baseUrl,
      [sessionKeys.authenticatedAt]: new Date().toISOString(),
      [sessionKeys.authDate]: formatIndiaDate(new Date()),
    });

    syncInstrumentMaster({ force: false }).catch((syncError) => {
      console.error("Instrument sync failed:", syncError.message);
    });

    res.json(getSessionState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    ensureCurrentSession();

    const [orders, trades, positions, holdings, limits] = await Promise.all([
      loadDashboardWidget(() => tradeRequest("/quick/user/orders"), { stat: "Ok", data: [] }),
      loadDashboardWidget(() => tradeRequest("/quick/user/trades"), { stat: "Ok", data: [] }),
      loadDashboardWidget(() => tradeRequest("/quick/user/positions"), { stat: "Ok", data: [] }),
      loadDashboardWidget(
        () => tradeRequest("/portfolio/v1/holdings"),
        { stat: "Ok", data: [] },
        { emptyStatePatterns: ["no holding", "no holdings", "holding not found"] },
      ),
      loadDashboardWidget(
        () =>
          tradeRequest("/quick/user/limits", {
            method: "POST",
            form: { jData: JSON.stringify({ exch: "ALL", seg: "ALL", prod: "ALL" }) },
          }),
        { stat: "Not_Ok", emsg: "Limits unavailable" },
      ),
    ]);

    res.json({
      orders,
      trades,
      positions,
      holdings,
      limits,
      errors: {
        orders: orders.__error ?? null,
        trades: trades.__error ?? null,
        positions: positions.__error ?? null,
        holdings: holdings.__error ?? null,
        limits: limits.__error ?? null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/pnl", async (req, res) => {
  try {
    ensureCurrentSession();

    const positionsResponse = await tradeRequest("/quick/user/positions");
    const positions = Array.isArray(positionsResponse?.data) ? positionsResponse.data : [];
    const quoteRows = await loadPositionQuotes(positions);
    const quoteMap = new Map(
      quoteRows.map((row) => [buildQuoteKey(row.exchange, row.exchange_token), row]),
    );

    const rows = positions.map((position) => buildPnlRow(position, quoteMap));
    const summary = summarizePnlRows(rows);

    res.json({
      stat: "Ok",
      summary,
      rows,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/quotes", async (req, res) => {
  try {
    const queriesParam = String(req.query.queries ?? "").trim();
    const filter = String(req.query.filter ?? "all").trim() || "all";

    if (!queriesParam) {
      res.status(400).json({ error: "At least one quotes query is required." });
      return;
    }

    const quotes = await loadQuotesByQueries(queriesParam.split(","), filter);
    res.json({ data: quotes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/realtime", async (req, res) => {
  let socket;
  let pingInterval;

  try {
    ensureCurrentSession();
    const wsUrl = toRealtimeWsUrl(normalizeBaseUrl(getState(sessionKeys.baseUrl)));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    res.write(`event: status\ndata: ${JSON.stringify({ connected: false, stage: "connecting" })}\n\n`);

    socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
      const payload = `{type:cn,Authorization:${getState(sessionKeys.sessionToken)},Sid:${getState(sessionKeys.sessionSid)},src:WEB}`;
      socket.send(payload);
      res.write(`event: status\ndata: ${JSON.stringify({ connected: true, stage: "socket-open" })}\n\n`);

      pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send("{type:hb}");
        }
      }, 30000);
    });

    socket.addEventListener("message", (event) => {
      const parsed = tryParseJson(String(event.data));
      const eventName = parsed?.type ? parsed.type : "message";
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(parsed)}\n\n`);
    });

    socket.addEventListener("close", () => {
      res.write(`event: status\ndata: ${JSON.stringify({ connected: false, stage: "closed" })}\n\n`);
      cleanup();
    });

    socket.addEventListener("error", () => {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Realtime socket error." })}\n\n`);
      cleanup();
    });

    req.on("close", () => cleanup());
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    cleanup();
  }

  function cleanup() {
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/api/orders/place", async (req, res) => {
  try {
    ensureCurrentSession();
    const result = await tradeRequest("/quick/order/rule/ms/place", {
      method: "POST",
      form: { jData: JSON.stringify(buildOrderPayload(req.body)) },
    });

    res.json({ orderNo: result?.nOrdNo ?? result?.data?.nOrdNo ?? null, raw: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/orders/margin-check", async (req, res) => {
  try {
    ensureCurrentSession();

    const orderInput = req.body ?? {};
    const instrument = findInstrumentForMargin(
      String(orderInput.symbol ?? ""),
      String(orderInput.exchangeSegment ?? "nse_cm"),
    );

    if (!instrument) {
      res.status(400).json({
        error: "Instrument token not found in the local master cache. Sync instrument master and use the exchange trading symbol.",
      });
      return;
    }

    const result = await tradeRequest("/quick/user/check-margin", {
      method: "POST",
      form: {
        jData: JSON.stringify(buildMarginPayload(orderInput, instrument)),
      },
    });

    res.json({
      ...result,
      instrument: {
        exchangeSegment: instrument.exchangeSegment,
        exchangeToken: instrument.exchangeToken,
        tradingSymbol: instrument.tradingSymbol,
        displaySymbol: instrument.displaySymbol,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/orders/:orderNo/modify", async (req, res) => {
  try {
    ensureCurrentSession();
    const result = await tradeRequest("/quick/order/vr/modify", {
      method: "POST",
      form: { jData: JSON.stringify(buildOrderPayload(req.body, { mode: "modify", orderNo: req.params.orderNo })) },
    });

    res.json({ raw: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/orders/:orderNo/cancel", async (req, res) => {
  try {
    ensureCurrentSession();
    const result = await tradeRequest("/quick/order/cancel", {
      method: "POST",
      form: { jData: JSON.stringify({ on: req.params.orderNo, am: "NO" }) },
    });

    res.json({ raw: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/orders/:orderNo/history", async (req, res) => {
  try {
    ensureCurrentSession();
    const result = await tradeRequest("/quick/order/history", {
      method: "POST",
      form: { jData: JSON.stringify({ nOrdNo: req.params.orderNo }) },
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const distDir = path.join(rootDir, "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(port,  () => {
  console.log(`Server listening on http://${host}:${port}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.log(`Local access: http://127.0.0.1:${port}`);
  }
});

function getSessionState() {
  const authDate = getState(sessionKeys.authDate);
  const authenticatedAt = getState(sessionKeys.authenticatedAt);
  const baseUrl = getState(sessionKeys.baseUrl);
  const hasSession = Boolean(
    getState(sessionKeys.sessionToken) &&
      getState(sessionKeys.sessionSid) &&
      baseUrl,
  );

  return {
    isAuthenticated: hasSession,
    isCurrentSession: hasSession && authDate === formatIndiaDate(new Date()),
    authDate,
    authenticatedAt,
    baseUrl: baseUrl || null,
    hasCredentials: hasStoredCredentials(getStoredCredentials()),
    dbPath: getDatabasePath(),
    instrumentCache: getInstrumentCacheStatus(),
  };
}

function ensureCurrentSession() {
  const session = getSessionState();
  if (!session.isAuthenticated) {
    throw new Error("Authenticate first. No Kotak session tokens are stored.");
  }
  if (!session.isCurrentSession) {
    throw new Error("Saved session is from a previous day. Authenticate again with today's TOTP.");
  }
}

function requireCredentials() {
  const stored = getStoredCredentials();
  const consumerKey = stored.consumerKey || process.env.KOTAK_CONSUMER_KEY;
  const mobileNumber = stored.mobileNumber || process.env.KOTAK_MOBILE_NUMBER;
  const ucc = stored.ucc || process.env.KOTAK_UCC;
  const mpin = stored.mpin || process.env.KOTAK_MPIN;

  if (!consumerKey || !mobileNumber || !ucc || !mpin) {
    throw new Error("Missing Kotak credentials. Save consumer key, mobile number, UCC, and MPIN from the dashboard settings.");
  }

  return { consumerKey, mobileNumber, ucc, mpin };
}

async function tradeRequest(endpoint, options = {}) {
  const baseUrl = normalizeBaseUrl(getState(sessionKeys.baseUrl));
  if (!baseUrl) {
    throw new Error("Base URL is missing. Authenticate first.");
  }

  const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const headers = {
    Accept: "application/json",
    Sid: getState(sessionKeys.sessionSid),
    Auth: getState(sessionKeys.sessionToken),
    "neo-fin-key": "neotradeapi",
    ...(options.headers ?? {}),
  };

  if (options.form) {
    return kotakFetch(url, {
      method: options.method ?? "POST",
      headers,
      body: new URLSearchParams(options.form).toString(),
      contentType: "application/x-www-form-urlencoded",
    });
  }

  return kotakFetch(url, {
    method: options.method ?? "GET",
    headers,
  });
}

async function loadQuotesByQueries(queries, filter = "ltp") {
  const sanitizedQueries = queries.filter(Boolean);
  if (!sanitizedQueries.length) {
    return [];
  }

  const config = requireCredentials();
  const baseUrl = normalizeBaseUrl(getState(sessionKeys.baseUrl)) || "https://mis.kotaksecurities.com";
  const url = `${baseUrl}/script-details/1.0/quotes/neosymbol/${encodeURI(sanitizedQueries.join(","))}/${encodeURIComponent(filter)}`;

  const quotes = await kotakFetch(url, {
    method: "GET",
    headers: {
      Authorization: config.consumerKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  return Array.isArray(quotes) ? quotes : Array.isArray(quotes?.data) ? quotes.data : [];
}

async function kotakFetch(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.contentType ? { "Content-Type": options.contentType } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body,
  });

  const text = await response.text();
  const data = tryParseJson(text);

  if (!response.ok || isKotakBusinessError(data)) {
    throw new Error(extractErrorMessage(data, text, response.status));
  }

  return data;
}

function buildOrderPayload(input = {}, options = {}) {
  const payload = {
    am: String(input.amo ?? "NO"),
    dq: String(input.disclosedQuantity ?? "0"),
    es: String(input.exchangeSegment ?? "nse_cm"),
    mp: String(input.marketProtection ?? "0"),
    pc: String(input.productCode ?? "CNC"),
    pf: String(input.pf ?? "N"),
    pr: String(input.price ?? "0"),
    pt: String(input.priceType ?? "MKT"),
    qt: String(input.quantity ?? "1"),
    rt: String(input.validity ?? "DAY"),
    tp: String(input.triggerPrice ?? "0"),
    ts: String(input.symbol ?? ""),
    tt: String(input.transactionType ?? "B"),
  };

  if (!payload.ts) {
    throw new Error("Trading symbol is required.");
  }

  if (options.mode === "modify") {
    payload.no = String(options.orderNo ?? "");
    payload.vd = payload.rt;
    if (!payload.no) {
      throw new Error("Order number is required to modify an order.");
    }
  }

  if (payload.pc === "BO") {
    payload.sot = String(input.squareOffType ?? "Absolute");
    payload.slt = String(input.stopLossType ?? "Absolute");
    payload.slv = String(input.stopLossValue ?? "");
    payload.sov = String(input.squareOffValue ?? "");
    payload.tlt = String(input.trailingStopLoss ?? "N");
    payload.lat = String(input.ltpReference ?? "LTP");
    payload.tsv = String(input.trailingStopLoss === "Y" ? input.trailingStopLossValue ?? "0" : "0");

    if (!payload.slv || !payload.sov) {
      throw new Error("Bracket order requires both target value and stop loss value.");
    }
  }

  return payload;
}

function buildPnlRow(position, quoteMap) {
  const exchangeSegment = String(position.exSeg ?? "");
  const instrument = findInstrumentRecord(
    String(position.trdSym ?? position.sym ?? ""),
    exchangeSegment,
  );
  const exchangeToken = instrument?.exchangeToken ?? "";
  const quote = quoteMap.get(buildQuoteKey(exchangeSegment, exchangeToken)) ?? null;

  const netQuantity = toNumber(position.qty) ?? 0;
  const buyQuantity = toNumber(position.flBuyQty) ?? 0;
  const sellQuantity = toNumber(position.flSellQty) ?? 0;
  const buyAmount = toNumber(position.buyAmt) ?? 0;
  const sellAmount = toNumber(position.sellAmt) ?? 0;
  const ltp = toNumber(quote?.ltp);

  const buyAverage = buyQuantity > 0 ? buyAmount / buyQuantity : null;
  const sellAverage = sellQuantity > 0 ? sellAmount / sellQuantity : null;
  const closedQuantity = Math.min(buyQuantity, sellQuantity);
  const realizedPnl =
    closedQuantity > 0 && buyAverage !== null && sellAverage !== null
      ? closedQuantity * (sellAverage - buyAverage)
      : 0;

  let openAverage = null;
  let unrealizedPnl = 0;
  if (netQuantity > 0) {
    openAverage = netQuantity !== 0 ? (buyAmount - sellAmount) / netQuantity : null;
    unrealizedPnl = ltp !== null && openAverage !== null ? netQuantity * (ltp - openAverage) : 0;
  } else if (netQuantity < 0) {
    openAverage = Math.abs(netQuantity) !== 0 ? (sellAmount - buyAmount) / Math.abs(netQuantity) : null;
    unrealizedPnl = ltp !== null && openAverage !== null ? Math.abs(netQuantity) * (openAverage - ltp) : 0;
  }

  return {
    symbol: String(position.trdSym ?? position.sym ?? "--"),
    exchange: exchangeSegment || "--",
    product: String(position.prod ?? "--"),
    netQuantity,
    buyQuantity,
    sellQuantity,
    buyAmount,
    sellAmount,
    buyAverage,
    sellAverage,
    openAverage,
    ltp,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    lastUpdated: String(position.hsUpTm ?? quote?.lstup_time ?? "--"),
    exchangeToken: exchangeToken || null,
    quoteFound: Boolean(quote),
  };
}

function summarizePnlRows(rows) {
  return rows.reduce(
    (summary, row) => {
      summary.realizedPnl += row.realizedPnl;
      summary.unrealizedPnl += row.unrealizedPnl;
      summary.totalPnl += row.totalPnl;
      summary.openPositions += row.netQuantity !== 0 ? 1 : 0;
      summary.closedPositions += row.netQuantity === 0 ? 1 : 0;
      return summary;
    },
    {
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      openPositions: 0,
      closedPositions: 0,
    },
  );
}

function buildMarginPayload(input = {}, instrument) {
  const payload = {
    brkName: "KOTAK",
    brnchId: "ONLINE",
    exSeg: String(input.exchangeSegment ?? instrument.exchangeSegment ?? "nse_cm"),
    prc: normalizeMarginPrice(input),
    prcTp: String(input.priceType ?? "MKT"),
    prod: String(input.productCode ?? "CNC"),
    qty: String(input.quantity ?? "1"),
    tok: String(instrument.exchangeToken ?? ""),
    trnsTp: String(input.transactionType ?? "B"),
  };

  if (!payload.tok) {
    throw new Error("Instrument token is missing for margin check.");
  }

  if (payload.prod === "BO") {
    payload.slAbsOrTks = String(input.stopLossType ?? "Absolute");
    payload.slVal = String(input.stopLossValue ?? "");
    payload.sqrOffAbsOrTks = String(input.squareOffType ?? "Absolute");
    payload.sqrOffVal = String(input.squareOffValue ?? "");
    payload.trailSL = String(input.trailingStopLoss ?? "N");
    payload.tSLTks = String(input.trailingStopLoss === "Y" ? input.trailingStopLossValue ?? "0" : "0");
  }

  if (payload.prod === "CO") {
    payload.trgPrc = String(input.triggerPrice ?? "0");
  }

  return payload;
}

function persistRuntimeSession(session) {
  for (const [key, value] of Object.entries(session)) {
    setState(key, value);
  }
}

async function syncInstrumentMaster({ force = false } = {}) {
  const today = formatIndiaDate(new Date());
  const currentStatus = getInstrumentCacheStatus();

  if (!force && currentStatus.isCurrent) {
    return currentStatus;
  }

  const { consumerKey } = requireCredentials();
  const baseUrl = normalizeBaseUrl(getState(sessionKeys.baseUrl));
  if (!baseUrl) {
    throw new Error("Authenticate first before syncing instrument master.");
  }

  const filesResponse = await kotakFetch(`${baseUrl}/script-details/1.0/masterscrip/file-paths`, {
    method: "GET",
    headers: {
      Authorization: consumerKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  const filePaths = filesResponse?.data?.filesPaths;
  if (!Array.isArray(filePaths) || !filePaths.length) {
    throw new Error("Instrument master file list is empty.");
  }

  const records = [];
  for (const filePath of filePaths) {
    const csvText = await fetchText(filePath);
    const segment = inferSegmentFromPath(filePath);
    const parsedRows = parseCsv(csvText);

    for (const row of parsedRows) {
      const mapped = mapInstrumentRow(row, segment);
      if (mapped.exchangeSegment && mapped.exchangeToken) {
        records.push(mapped);
      }
    }
  }

  const payload = {
    syncDate: today,
    syncedAt: new Date().toISOString(),
    sourceFiles: filePaths,
    totalRecords: records.length,
    records,
  };

  const filePath = path.join(instrumentsDir, `instrument-master-${today}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

  setState(instrumentKeys.lastSyncDate, today);
  setState(instrumentKeys.lastSyncAt, payload.syncedAt);
  setState(instrumentKeys.lastSyncPath, filePath);
  setState(instrumentKeys.lastSyncCount, String(records.length));

  return getInstrumentCacheStatus();
}

function getInstrumentCacheStatus() {
  const syncDate = getState(instrumentKeys.lastSyncDate);
  const syncedAt = getState(instrumentKeys.lastSyncAt);
  const filePath = getState(instrumentKeys.lastSyncPath);
  const totalRecords = Number(getState(instrumentKeys.lastSyncCount) ?? 0);

  return {
    isCurrent: Boolean(syncDate && syncDate === formatIndiaDate(new Date()) && filePath && fs.existsSync(filePath)),
    syncDate: syncDate || null,
    syncedAt: syncedAt || null,
    filePath: filePath || null,
    totalRecords,
  };
}

function readInstrumentCache() {
  const status = getInstrumentCacheStatus();
  if (!status.filePath || !fs.existsSync(status.filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(status.filePath, "utf8"));
}

function findInstrumentForMargin(symbol, exchangeSegment) {
  return findInstrumentRecord(symbol, exchangeSegment);
}

function findInstrumentRecord(symbol, exchangeSegment) {
  const normalizedSymbol = normalizeInstrumentKey(symbol);
  const normalizedExchange = String(exchangeSegment ?? "").trim().toLowerCase();
  const cache = readInstrumentCache();
  const rows = cache?.records ?? [];

  if (!normalizedSymbol || !normalizedExchange) {
    return null;
  }

  const exactMatch = rows.find((row) => {
    if (row.exchangeSegment !== normalizedExchange) {
      return false;
    }

    return (
      normalizeInstrumentKey(row.tradingSymbol) === normalizedSymbol ||
      normalizeInstrumentKey(row.displaySymbol) === normalizedSymbol ||
      normalizeInstrumentKey(row.instrumentName) === normalizedSymbol
    );
  });

  if (exactMatch) {
    return exactMatch;
  }

  return rows.find((row) => {
    if (row.exchangeSegment !== normalizedExchange) {
      return false;
    }

    return (
      normalizeInstrumentKey(row.tradingSymbol).includes(normalizedSymbol) ||
      normalizeInstrumentKey(row.displaySymbol).includes(normalizedSymbol)
    );
  }) ?? null;
}

async function loadPositionQuotes(positions) {
  const queries = [];
  const seen = new Set();

  for (const position of positions) {
    const instrument = findInstrumentRecord(
      String(position.trdSym ?? position.sym ?? ""),
      String(position.exSeg ?? ""),
    );

    if (!instrument?.exchangeSegment || !instrument?.exchangeToken) {
      continue;
    }

    const query = `${instrument.exchangeSegment}|${instrument.exchangeToken}`;
    if (seen.has(query)) {
      continue;
    }

    seen.add(query);
    queries.push(query);
  }

  return loadQuotesByQueries(queries, "ltp");
}

function normalizeInstrumentKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

function buildQuoteKey(exchange, token) {
  return `${String(exchange ?? "").trim().toLowerCase()}|${String(token ?? "").trim().toLowerCase()}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMarginPrice(input) {
  const priceType = String(input.priceType ?? "MKT");
  if (priceType === "MKT" || priceType === "SL-M") {
    return "0";
  }
  return String(input.price ?? "0");
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download instrument master file: ${url}`);
  }
  return response.text();
}

function inferSegmentFromPath(filePath) {
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (fileName.includes("nse_cm")) return "nse_cm";
  if (fileName.includes("bse_cm")) return "bse_cm";
  if (fileName.includes("nse_fo")) return "nse_fo";
  if (fileName.includes("bse_fo")) return "bse_fo";
  if (fileName.includes("cde_fo")) return "cde_fo";
  if (fileName.includes("mcx_fo")) return "mcx_fo";
  if (fileName.includes("nse_com")) return "nse_com";
  return "";
}

function mapInstrumentRow(row, fallbackSegment) {
  return {
    exchangeSegment: String(firstDefined(row, ["pExchSeg", "exchangeSegment"]) ?? fallbackSegment ?? "").toLowerCase(),
    exchangeToken: String(firstDefined(row, ["pSymbol", "exchangeIdentifier", "instrumentToken"]) ?? ""),
    tradingSymbol: String(firstDefined(row, ["pTrdSymbol", "tradingSymbol", "displaySymbol", "symbol"]) ?? ""),
    displaySymbol: String(firstDefined(row, ["displaySymbol", "symbol", "pSymbolName", "instrumentName"]) ?? ""),
    instrumentName: String(firstDefined(row, ["instrumentName", "pSymbolName", "companyName", "symbol"]) ?? ""),
    lotSize: String(firstDefined(row, ["lLotSize", "marketLot"]) ?? ""),
    expiryDate: String(firstDefined(row, ["lExpiryDate", "expiryDate"]) ?? ""),
    strikePrice: String(firstDefined(row, ["strikePrice", "dStrikePrice"]) ?? ""),
    optionType: String(firstDefined(row, ["optType", "optionType"]) ?? ""),
  };
}

function firstDefined(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return null;
}

function parseCsv(csvText) {
  const rows = [];
  const lines = splitCsvLines(csvText);
  if (!lines.length) {
    return rows;
  }

  const headers = parseCsvLine(lines[0]);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvLines(csvText) {
  const lines = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (current) {
        lines.push(current.replace(/\r$/, ""));
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

async function loadDashboardWidget(loader, fallback, options = {}) {
  try {
    return await loader();
  } catch (error) {
    const message = formatUnknownError(error);
    const shouldTreatAsEmpty = (options.emptyStatePatterns ?? []).some((pattern) =>
      message.toLowerCase().includes(pattern),
    );

    const payload = shouldTreatAsEmpty ? fallback : { ...fallback, __error: message };
    if (!shouldTreatAsEmpty && payload.stat === "Ok" && Array.isArray(payload.data)) {
      payload.stat = "Not_Ok";
      payload.emsg = message;
    }

    return payload;
  }
}

function extractErrorMessage(data, text, status) {
  if (data && typeof data === "object") {
    const candidate =
      data.error ||
      data.message ||
      data.emsg ||
      data.msg ||
      data?.data?.message ||
      data?.raw ||
      `Kotak request failed with status ${status}.`;

    return formatUnknownError(candidate);
  }
  return formatUnknownError(text || `Kotak request failed with status ${status}.`);
}

function normalizeBaseUrl(value) {
  if (!value) {
    return "";
  }
  const trimmed = String(value).trim().replace(/\/+$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function toRealtimeWsUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.search = "";
  return url.toString();
}

function tryParseJson(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function formatUnknownError(error) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const nested =
      error.message ||
      error.error ||
      error.emsg ||
      error.msg ||
      error.raw;

    if (typeof nested === "string") {
      return nested;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function isKotakBusinessError(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  return data.stat === "Not_Ok" || (typeof data.stCode === "number" && data.stCode !== 200);
}

function getStoredCredentials() {
  const state = getStates("credential.");
  return {
    consumerKey: state[credentialKeys.consumerKey] ?? "",
    mobileNumber: state[credentialKeys.mobileNumber] ?? "",
    ucc: state[credentialKeys.ucc] ?? "",
    mpin: state[credentialKeys.mpin] ?? "",
  };
}

function hasStoredCredentials(credentials) {
  return Boolean(credentials.consumerKey && credentials.mobileNumber && credentials.ucc && credentials.mpin);
}

function formatIndiaDate(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: indiaTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}
