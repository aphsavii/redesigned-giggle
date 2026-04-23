import { useEffect, useMemo, useState } from "react";

const initialOrderForm = {
  symbol: "",
  exchangeSegment: "nse_cm",
  productCode: "CNC",
  priceType: "MKT",
  quantity: "1",
  transactionType: "B",
  price: "0",
  triggerPrice: "0",
  disclosedQuantity: "0",
  amo: "NO",
  validity: "DAY",
  marketProtection: "0",
  squareOffType: "Absolute",
  squareOffValue: "",
  stopLossType: "Absolute",
  stopLossValue: "",
  trailingStopLoss: "N",
  trailingStopLossValue: "0",
  ltpReference: "LTP",
};

function App() {
  const modifySectionId = "modify-order";
  const [activeView, setActiveView] = useState("trade");
  const [totp, setTotp] = useState("");
  const [authStatus, setAuthStatus] = useState(null);
  const [settings, setSettings] = useState({
    consumerKey: "",
    mobileNumber: "",
    ucc: "",
    mpin: "",
    hasCredentials: false,
    dbPath: "",
  });
  const [settingsForm, setSettingsForm] = useState({
    consumerKey: "",
    mobileNumber: "",
    ucc: "",
    mpin: "",
  });
  const [dashboard, setDashboard] = useState(null);
  const [streamStatus, setStreamStatus] = useState({ connected: false, stage: "idle" });
  const [streamEvents, setStreamEvents] = useState([]);
  const [livePositions, setLivePositions] = useState([]);
  const [pnlData, setPnlData] = useState(null);
  const [orderForm, setOrderForm] = useState(initialOrderForm);
  const [modifyForm, setModifyForm] = useState({ ...initialOrderForm, orderNo: "" });
  const [orderMargin, setOrderMargin] = useState({ state: "idle", data: null, error: "" });
  const [selectedOrderHistory, setSelectedOrderHistory] = useState([]);
  const [selectedOrderNo, setSelectedOrderNo] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const orders = useMemo(() => toRows(dashboard?.orders), [dashboard]);
  const trades = useMemo(() => toRows(dashboard?.trades), [dashboard]);
  const positions = useMemo(
    () => (livePositions.length ? livePositions : toRows(dashboard?.positions)),
    [dashboard, livePositions],
  );
  const holdings = useMemo(() => toRows(dashboard?.holdings), [dashboard]);
  const limits = dashboard?.limits;
  const pnlRows = pnlData?.rows ?? [];
  const views = [
    { id: "setup", label: "Setup" },
    { id: "trade", label: "Trade" },
    { id: "monitor", label: "Monitor" },
  ];

  useEffect(() => {
    loadSettings();
    loadStatus();
  }, []);

  useEffect(() => {
    if (authStatus?.isCurrentSession) {
      loadDashboard(false);
      loadPnl(false);
    } else {
      setLivePositions([]);
      setPnlData(null);
    }
  }, [authStatus?.isCurrentSession]);

  useEffect(() => {
    if (!authStatus?.isCurrentSession) {
      setStreamStatus({ connected: false, stage: "idle" });
      return undefined;
    }

    const source = new EventSource("/api/realtime");
    source.addEventListener("status", (event) => {
      setStreamStatus(JSON.parse(event.data));
    });
    source.addEventListener("order", (event) => {
      const data = JSON.parse(event.data);
      pushStreamEvent("order", data.data ?? data);
      loadDashboard(false);
      loadPnl(false);
    });
    source.addEventListener("position", (event) => {
      const data = JSON.parse(event.data);
      const payload = data.data ?? data;
      pushStreamEvent("position", payload);
      applyLivePositionUpdate(payload);
      loadPnl(false);
    });
    source.addEventListener("message", (event) => {
      pushStreamEvent("message", JSON.parse(event.data));
    });
    source.addEventListener("error", () => {
      setStreamStatus({ connected: false, stage: "error" });
    });

    return () => source.close();
  }, [authStatus?.isCurrentSession]);

  useEffect(() => {
    if (!authStatus?.isCurrentSession || activeView !== "monitor") {
      return undefined;
    }

    loadPnl(false);
    const interval = setInterval(() => loadPnl(false), 5000);
    return () => clearInterval(interval);
  }, [authStatus?.isCurrentSession, activeView]);

  useEffect(() => {
    if (!authStatus?.isCurrentSession) {
      setOrderMargin({ state: "idle", data: null, error: "" });
      return undefined;
    }

    if (!canCheckMargin(orderForm)) {
      setOrderMargin({ state: "idle", data: null, error: "" });
      return undefined;
    }

    let active = true;
    setOrderMargin((current) => ({ state: "loading", data: current.data, error: "" }));

    const timeout = setTimeout(async () => {
      try {
        const data = await api("/api/orders/margin-check", {
          method: "POST",
          body: orderForm,
        });

        if (!active) {
          return;
        }

        setOrderMargin({ state: "ready", data, error: "" });
      } catch (err) {
        if (!active) {
          return;
        }

        setOrderMargin({ state: "error", data: null, error: err.message });
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [authStatus?.isCurrentSession, orderForm]);

  async function loadStatus() {
    try {
      const data = await api("/api/auth/status");
      setAuthStatus(data);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      setSettings(data);
      setSettingsForm({
        consumerKey: data.consumerKey ?? "",
        mobileNumber: data.mobileNumber ?? "",
        ucc: data.ucc ?? "",
        mpin: data.mpin ?? "",
      });
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadDashboard(showMessage = true) {
    try {
      setBusyAction("refresh");
      const data = await api("/api/dashboard");
      setDashboard(data);
      setLivePositions(toRows(data.positions));
      if (showMessage) {
        setMessage("Dashboard refreshed.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveSettings(event) {
    event.preventDefault();
    try {
      setBusyAction("settings");
      const data = await api("/api/settings", {
        method: "POST",
        body: settingsForm,
      });
      setSettings(data);
      setMessage("Credentials saved to local SQLite database.");
      setError("");
      await loadStatus();
    } catch (err) {
      setError(err.message);
      setMessage("");
    } finally {
      setBusyAction("");
    }
  }

  async function handleAuthenticate(event) {
    event.preventDefault();
    try {
      setBusyAction("auth");
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { totp },
      });
      setAuthStatus(data);
      setTotp("");
      setMessage("Authentication completed for today.");
      setError("");
      await loadDashboard(false);
      await loadStatus();
    } catch (err) {
      setError(err.message);
      setMessage("");
    } finally {
      setBusyAction("");
    }
  }

  async function handleRefreshInstruments() {
    try {
      setBusyAction("instrument-refresh");
      await api("/api/instruments/refresh", { method: "POST" });
      await loadStatus();
      setMessage("Instrument master synced for today.");
      setError("");
    } catch (err) {
      setError(err.message);
      setMessage("");
    } finally {
      setBusyAction("");
    }
  }

  async function handlePlaceOrder(event) {
    event.preventDefault();
    try {
      setBusyAction("place");
      const data = await api("/api/orders/place", {
        method: "POST",
        body: orderForm,
      });
      setMessage(`Order placed${data.orderNo ? `: ${data.orderNo}` : ""}`);
      setError("");
      await loadDashboard(false);
    } catch (err) {
      setError(err.message);
      setMessage("");
    } finally {
      setBusyAction("");
    }
  }

  async function handleModifyOrder(event) {
    event.preventDefault();
    try {
      setBusyAction("modify");
      const { orderNo, ...payload } = modifyForm;
      await api(`/api/orders/${orderNo}/modify`, {
        method: "POST",
        body: payload,
      });
      setMessage(`Order ${orderNo} updated.`);
      setError("");
      await loadDashboard(false);
    } catch (err) {
      setError(err.message);
      setMessage("");
    } finally {
      setBusyAction("");
    }
  }

  async function handleCancelOrder(orderNo) {
    try {
      setBusyAction(`cancel-${orderNo}`);
      await api(`/api/orders/${orderNo}/cancel`, { method: "POST" });
      setMessage(`Order ${orderNo} cancelled.`);
      setError("");
      await loadDashboard(false);
    } catch (err) {
      setError(err.message);
      setMessage("");
    } finally {
      setBusyAction("");
    }
  }

  async function loadOrderHistory(orderNo) {
    try {
      setBusyAction(`history-${orderNo}`);
      const data = await api(`/api/orders/${orderNo}/history`);
      setSelectedOrderNo(orderNo);
      setSelectedOrderHistory(toRows(data));
      setError("");
    } catch (err) {
      setError(err.message);
      setSelectedOrderNo(orderNo);
      setSelectedOrderHistory([]);
    } finally {
      setBusyAction("");
    }
  }

  async function loadPnl(showMessage = true) {
    try {
      setBusyAction("pnl");
      const data = await api("/api/pnl");
      setPnlData(data);
      if (showMessage) {
        setMessage("P&L refreshed.");
      }
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  function pushStreamEvent(type, payload) {
    setStreamEvents((current) =>
      [
        { type, payload, timestamp: new Date().toISOString() },
        ...current,
      ].slice(0, 12),
    );
  }

  function applyLivePositionUpdate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }

    setLivePositions((current) => {
      const base = current.length ? current : toRows(dashboard?.positions);
      const nextRow = normalizePositionRow(payload);
      const index = base.findIndex((row) => isSamePosition(row, nextRow));

      if (index === -1) {
        return [payload, ...base];
      }

      const next = [...base];
      next[index] = { ...next[index], ...payload };
      return next;
    });
  }

  function loadOrderIntoModify(order) {
    setModifyForm({
      orderNo: String(order.no ?? order.nOrdNo ?? order.orderNo ?? ""),
      symbol: String(order.ts ?? order.trdSym ?? order.symbol ?? ""),
      exchangeSegment: String(order.es ?? order.exSeg ?? "nse_cm"),
      productCode: String(order.pc ?? order.prod ?? "CNC"),
      priceType: String(order.pt ?? order.prcTp ?? "L"),
      quantity: String(order.qt ?? order.qty ?? order.quantity ?? "1"),
      transactionType: String(order.tt ?? order.trnsTp ?? "B"),
      price: String(order.pr ?? order.price ?? "0"),
      triggerPrice: String(order.tp ?? order.triggerPrice ?? "0"),
      disclosedQuantity: String(order.dq ?? order.disclosedQuantity ?? "0"),
      amo: String(order.am ?? "NO"),
      validity: String(order.rt ?? order.vd ?? "DAY"),
      marketProtection: String(order.mp ?? "0"),
    });
    setActiveView("trade");
    window.location.hash = modifySectionId;
  }

  const sessionTone = authStatus?.isCurrentSession
    ? "border-emerald-500/30 bg-emerald-500/10"
    : "border-amber-500/30 bg-amber-500/10";

  return (
    <main className="min-h-screen overflow-x-hidden px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6">
        <header className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-sky-950/20 backdrop-blur">
          <p className="text-sm uppercase tracking-[0.32em] text-sky-300">Kotak Neo Trade API</p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-white">Trading Console</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-300">
                Split into focused screens so setup, order entry, and monitoring stay separate.
              </p>
            </div>
            <div className={`rounded-2xl border px-4 py-3 text-sm ${sessionTone}`}>
              <div className="font-medium text-white">
                {authStatus?.isCurrentSession ? "Session active" : "Authentication required"}
              </div>
              <div className="mt-1 text-slate-300">
                {authStatus?.authenticatedAt
                  ? `Last login: ${new Date(authStatus.authenticatedAt).toLocaleString()}`
                  : "No valid session saved yet."}
              </div>
              <div className="mt-1 text-slate-400">
                {settings.hasCredentials ? "Credentials saved locally." : "Save credentials before authenticating."}
              </div>
            </div>
          </div>
        </header>

        <section className="flex flex-wrap gap-3">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => setActiveView(view.id)}
              className={`rounded-2xl px-4 py-2 text-sm font-medium transition ${
                activeView === view.id
                  ? "bg-sky-400 text-slate-950"
                  : "border border-slate-800 bg-slate-900/70 text-slate-200 hover:border-slate-600"
              }`}
            >
              {view.label}
            </button>
          ))}
        </section>

        {(message || error) && (
          <div className="pointer-events-none fixed left-4 right-4 top-4 z-50 flex flex-col gap-3 sm:left-auto sm:w-full sm:max-w-sm">
            <Banner tone="success" text={message} />
            <Banner tone="error" text={error} />
          </div>
        )}

        {activeView === "setup" && (
          <section className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
            <Card title="Kotak Settings" subtitle="Save your API key, mobile number, UCC, and MPIN locally in SQLite.">
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSaveSettings}>
                <Field label="Consumer Key">
                  <input className={inputClassName} value={settingsForm.consumerKey} onChange={(event) => setSettingsForm((current) => ({ ...current, consumerKey: event.target.value }))} placeholder="NEO API token" />
                </Field>
                <Field label="Mobile Number">
                  <input className={inputClassName} value={settingsForm.mobileNumber} onChange={(event) => setSettingsForm((current) => ({ ...current, mobileNumber: event.target.value }))} placeholder="+91XXXXXXXXXX" />
                </Field>
                <Field label="UCC">
                  <input className={inputClassName} value={settingsForm.ucc} onChange={(event) => setSettingsForm((current) => ({ ...current, ucc: event.target.value }))} placeholder="Client code" />
                </Field>
                <Field label="MPIN">
                  <input className={inputClassName} type="password" value={settingsForm.mpin} onChange={(event) => setSettingsForm((current) => ({ ...current, mpin: event.target.value }))} placeholder="6-digit MPIN" />
                </Field>
                <div className="sm:col-span-2 flex flex-wrap gap-3">
                  <button className="rounded-2xl bg-sky-400 px-5 py-3 font-medium text-slate-950 transition hover:bg-sky-300 disabled:opacity-60" type="submit" disabled={busyAction === "settings"}>
                    {busyAction === "settings" ? "Saving..." : "Save credentials"}
                  </button>
                  <button className="rounded-2xl border border-slate-700 px-5 py-3 text-slate-200 transition hover:border-slate-500" type="button" onClick={() => loadSettings()}>
                    Reload saved values
                  </button>
                </div>
              </form>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Stat label="Storage" value={settings.dbPath || "--"} />
                <Stat label="Credentials ready" value={settings.hasCredentials ? "Yes" : "No"} />
              </div>
            </Card>

            <Card title="Daily Authentication" subtitle="Authenticate once per trading day after saving credentials.">
              <form className="flex flex-col gap-4" onSubmit={handleAuthenticate}>
                <label className="flex flex-col gap-2 text-sm text-slate-300">
                  TOTP
                  <input className="rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none ring-0 transition focus:border-sky-400" value={totp} onChange={(event) => setTotp(event.target.value)} placeholder="Enter current TOTP" inputMode="numeric" />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button className="rounded-2xl bg-sky-400 px-5 py-3 font-medium text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-60" type="submit" disabled={busyAction === "auth" || !totp || !settings.hasCredentials}>
                    {busyAction === "auth" ? "Authenticating..." : "Authenticate"}
                  </button>
                  <button className="rounded-2xl border border-slate-700 px-5 py-3 text-slate-200 transition hover:border-slate-500" type="button" onClick={() => loadStatus()}>
                    Check status
                  </button>
                </div>
              </form>
              <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <div className="text-sm font-medium text-white">Instrument master</div>
                    <div className="mt-1 text-sm text-slate-400">
                      {authStatus?.instrumentCache?.isCurrent
                        ? "Today’s instrument cache is ready."
                        : "Today’s instrument cache is missing. Margin checks and token-based APIs can fail until you sync it."}
                    </div>
                  </div>
                  <button
                    className="rounded-2xl border border-slate-700 px-5 py-3 text-slate-200 transition hover:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                    type="button"
                    onClick={handleRefreshInstruments}
                    disabled={!authStatus?.isCurrentSession || busyAction === "instrument-refresh"}
                  >
                    {busyAction === "instrument-refresh" ? "Syncing..." : "Update instrument master"}
                  </button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Stat label="Cache Status" value={authStatus?.instrumentCache?.isCurrent ? "Current" : "Missing"} />
                  <Stat label="Sync Date" value={authStatus?.instrumentCache?.syncDate ?? "--"} />
                  <Stat label="Synced At" value={authStatus?.instrumentCache?.syncedAt ? new Date(authStatus.instrumentCache.syncedAt).toLocaleString() : "--"} />
                  <Stat label="Records" value={authStatus?.instrumentCache?.totalRecords ?? "--"} />
                </div>
              </div>
            </Card>
          </section>
        )}

        {activeView === "trade" && (
          <section className="grid gap-6">
            <section className="grid gap-6 xl:grid-cols-2">
              <Card title="Place Order" subtitle="Primary entry form for new orders.">
                <OrderForm
                  form={orderForm}
                  onChange={setOrderForm}
                  submitLabel={busyAction === "place" ? "Placing..." : "Place order"}
                  onSubmit={handlePlaceOrder}
                  marginState={orderMargin}
                  limits={limits}
                />
              </Card>
              <Card title="Modify Order" subtitle="Use Edit from the order book to preload this form, then submit the changes." id={modifySectionId}>
                <OrderForm form={modifyForm} onChange={setModifyForm} includeOrderNo submitLabel={busyAction === "modify" ? "Updating..." : "Modify order"} onSubmit={handleModifyOrder} />
              </Card>
            </section>

            <OrderBookTable
              rows={orders}
              onEdit={loadOrderIntoModify}
              onCancel={handleCancelOrder}
              onHistory={loadOrderHistory}
              busyAction={busyAction}
            />

            <OrderHistoryPanel orderNo={selectedOrderNo} rows={selectedOrderHistory} />
          </section>
        )}

        {activeView === "monitor" && (
          <section className="grid gap-6">
            <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
              <Card title="Account Snapshot" subtitle="Session, limits, and refresh controls.">
                <div className="flex flex-wrap gap-3">
                  <button className="rounded-2xl bg-white/10 px-5 py-3 text-sm font-medium text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60" type="button" onClick={() => { loadDashboard(); loadPnl(false); }} disabled={!authStatus?.isCurrentSession || busyAction === "refresh"}>
                    {busyAction === "refresh" ? "Refreshing..." : "Refresh dashboard"}
                  </button>
                  <button className="rounded-2xl border border-slate-700 px-5 py-3 text-sm font-medium text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60" type="button" onClick={() => loadPnl()} disabled={!authStatus?.isCurrentSession || busyAction === "pnl"}>
                    {busyAction === "pnl" ? "Refreshing..." : "Refresh P&L"}
                  </button>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <Stat label="Session date" value={authStatus?.authDate ?? "--"} />
                  <Stat label="Base URL" value={authStatus?.baseUrl ?? "--"} />
                  <Stat label="Credential set" value={authStatus?.hasCredentials ? "Saved" : "Missing"} />
                  <Stat label="Realtime stream" value={`${streamStatus.connected ? "Connected" : "Offline"} / ${streamStatus.stage}`} />
                  {Object.entries(flattenObject(limits)).slice(0, 6).map(([key, value]) => (
                    <Stat key={key} label={key} value={String(value)} />
                  ))}
                </div>
              </Card>

              <Card title="P&L Dashboard" subtitle="Current day realized and unrealized P&L from positions plus live LTP for your position symbols.">
                <PnlSummary summary={pnlData?.summary} updatedAt={pnlData?.updatedAt} />
              </Card>
            </section>

            <section className="grid gap-6 xl:grid-cols-2">
              <PositionsTable rows={positions} pnlRows={pnlRows} />
              <TradesTable rows={trades} />
            </section>

            <PnlTable rows={pnlRows} />

            <DataTable title="Holdings" rows={holdings} emptyText="No holdings returned." />

            <Card title="Realtime Feed" subtitle="Server-side SSE bridge over Kotak order and position websocket.">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Connection" value={streamStatus.connected ? "Connected" : "Disconnected"} />
                <Stat label="Stage" value={streamStatus.stage} />
                <Stat label="Events kept" value={String(streamEvents.length)} />
              </div>
              <div className="mt-5 space-y-3">
                {streamEvents.length ? (
                  streamEvents.map((event, index) => (
                    <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium uppercase tracking-[0.18em] text-sky-300">{event.type}</div>
                        <div className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleTimeString()}</div>
                      </div>
                      <pre className="mt-3 overflow-x-auto text-xs text-slate-200">{JSON.stringify(event.payload, null, 2)}</pre>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
                    Waiting for order or position updates.
                  </div>
                )}
              </div>
            </Card>
          </section>
        )}
      </div>
    </main>
  );
}

function Card({ title, subtitle, children, id }) {
  return (
    <section
      id={id}
      className="min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur"
    >
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Banner({ tone, text }) {
  if (!text) {
    return null;
  }

  const tones = {
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
    error: "border-rose-500/30 bg-rose-500/10 text-rose-100",
  };

  return (
    <div className={`pointer-events-auto rounded-2xl border px-4 py-3 text-sm shadow-2xl backdrop-blur ${tones[tone]}`}>
      {text}
    </div>
  );
}

function OrderForm({
  form,
  onChange,
  onSubmit,
  submitLabel,
  includeOrderNo = false,
  marginState = { state: "idle", data: null, error: "" },
  limits = null,
}) {
  function updateField(key, value) {
    onChange((current) => ({ ...current, [key]: value }));
  }

  const isBracketOrder = form.productCode === "BO";
  const isCoverOrder = form.productCode === "CO";
  const needsTriggerPrice =
    isCoverOrder || form.priceType === "SL" || form.priceType === "SL-M";
  const needsPrice =
    form.priceType === "L" || form.priceType === "SL";
  const showDisclosedQuantity = !isBracketOrder && !isCoverOrder;
  const showValidity = !isBracketOrder && !isCoverOrder;
  const showAmo = !isBracketOrder && !isCoverOrder;
  const showMarketProtection = form.priceType === "MKT" || form.priceType === "SL-M";
  const marginAvailable = pickMarginAvailable(marginState.data, limits);
  const requiredMargin = pickRequiredMargin(marginState.data);
  const orderMargin = toNumber(marginState.data?.ordMrgn);
  const insufficientFunds = pickMarginShortfall(marginState.data, marginAvailable, requiredMargin);
  const isWithinMargin =
    marginState.state === "ready" &&
    requiredMargin !== null &&
    marginAvailable !== null &&
    requiredMargin <= marginAvailable;
  const leverageBasePrice =
    form.priceType === "MKT" || form.priceType === "SL-M"
      ? 0
      : toNumber(form.price) ?? 0;
  const notionalValue = leverageBasePrice * (toNumber(form.quantity) ?? 0);
  const indicativeMisMargin =
    form.productCode === "MIS"
      ? pickIndicativeMisMargin({ notionalValue, orderMargin })
      : null;

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
      {includeOrderNo && (
        <Field label="Order No">
          <input className={inputClassName} value={form.orderNo} onChange={(event) => updateField("orderNo", event.target.value)} placeholder="240611000000675" />
        </Field>
      )}
      <Field label="Symbol">
        <input className={inputClassName} value={form.symbol} onChange={(event) => updateField("symbol", event.target.value)} placeholder="TCS-EQ" />
      </Field>
      <Field label="Exchange">
        <select className={inputClassName} value={form.exchangeSegment} onChange={(event) => updateField("exchangeSegment", event.target.value)}>
          <option value="nse_cm">NSE CM</option>
          <option value="bse_cm">BSE CM</option>
        </select>
      </Field>
      <Field label="Product">
        <select className={inputClassName} value={form.productCode} onChange={(event) => updateField("productCode", event.target.value)}>
          <option value="CNC">CNC</option>
          <option value="MIS">MIS</option>
          <option value="NRML">NRML</option>
          <option value="CO">CO</option>
          <option value="BO">BO</option>
          <option value="MTF">MTF</option>
        </select>
      </Field>
      <Field label="Side">
        <select className={inputClassName} value={form.transactionType} onChange={(event) => updateField("transactionType", event.target.value)}>
          <option value="B">Buy</option>
          <option value="S">Sell</option>
        </select>
      </Field>
      <Field label="Price Type">
        <select className={inputClassName} value={form.priceType} onChange={(event) => updateField("priceType", event.target.value)}>
          <option value="MKT">Market</option>
          <option value="L">Limit</option>
          <option value="SL">Stop Loss</option>
          <option value="SL-M">Stop Loss Market</option>
        </select>
      </Field>
      <Field label="Quantity">
        <input className={inputClassName} value={form.quantity} onChange={(event) => updateField("quantity", event.target.value)} inputMode="numeric" />
      </Field>
      {needsPrice && (
        <Field label="Price">
          <input className={inputClassName} value={form.price} onChange={(event) => updateField("price", event.target.value)} inputMode="decimal" />
        </Field>
      )}
      {needsTriggerPrice && (
        <Field label="Trigger Price">
          <input className={inputClassName} value={form.triggerPrice} onChange={(event) => updateField("triggerPrice", event.target.value)} inputMode="decimal" />
        </Field>
      )}
      {showDisclosedQuantity && (
        <Field label="Disclosed Qty">
          <input className={inputClassName} value={form.disclosedQuantity} onChange={(event) => updateField("disclosedQuantity", event.target.value)} inputMode="numeric" />
        </Field>
      )}
      {showValidity && (
        <Field label="Validity">
          <select className={inputClassName} value={form.validity} onChange={(event) => updateField("validity", event.target.value)}>
            <option value="DAY">DAY</option>
            <option value="IOC">IOC</option>
          </select>
        </Field>
      )}
      {showAmo && (
        <Field label="AMO">
          <select className={inputClassName} value={form.amo} onChange={(event) => updateField("amo", event.target.value)}>
            <option value="NO">NO</option>
            <option value="YES">YES</option>
          </select>
        </Field>
      )}
      {showMarketProtection && (
        <Field label="Market Protection">
          <input className={inputClassName} value={form.marketProtection} onChange={(event) => updateField("marketProtection", event.target.value)} inputMode="decimal" />
        </Field>
      )}
      {isBracketOrder && (
        <>
          <div className="sm:col-span-2 rounded-2xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-sm text-slate-300">
            Bracket orders require target and stop-loss offsets in price points. Trailing stop is optional.
          </div>
          <Field label="Target Type">
            <select className={inputClassName} value={form.squareOffType} onChange={(event) => updateField("squareOffType", event.target.value)}>
              <option value="Absolute">Absolute</option>
              <option value="Ticks">Ticks</option>
            </select>
          </Field>
          <Field label="Target Value">
            <input className={inputClassName} value={form.squareOffValue} onChange={(event) => updateField("squareOffValue", event.target.value)} inputMode="decimal" placeholder="10.00" />
          </Field>
          <Field label="Stop Loss Type">
            <select className={inputClassName} value={form.stopLossType} onChange={(event) => updateField("stopLossType", event.target.value)}>
              <option value="Absolute">Absolute</option>
              <option value="Ticks">Ticks</option>
            </select>
          </Field>
          <Field label="Stop Loss Value">
            <input className={inputClassName} value={form.stopLossValue} onChange={(event) => updateField("stopLossValue", event.target.value)} inputMode="decimal" placeholder="5.00" />
          </Field>
          <Field label="Trailing Stop">
            <select className={inputClassName} value={form.trailingStopLoss} onChange={(event) => updateField("trailingStopLoss", event.target.value)}>
              <option value="N">No</option>
              <option value="Y">Yes</option>
            </select>
          </Field>
          <Field label="Trailing Value">
            <input className={inputClassName} value={form.trailingStopLossValue} onChange={(event) => updateField("trailingStopLossValue", event.target.value)} inputMode="decimal" placeholder="2.00" disabled={form.trailingStopLoss !== "Y"} />
          </Field>
        </>
      )}
      {!includeOrderNo && (
        <div className="sm:col-span-2">
          <MarginSummary
            marginState={marginState}
            marginAvailable={marginAvailable}
            requiredMargin={requiredMargin}
            orderMargin={orderMargin}
            insufficientFunds={insufficientFunds}
            isWithinMargin={isWithinMargin}
            productCode={form.productCode}
            indicativeMisMargin={indicativeMisMargin}
          />
        </div>
      )}
      <div className="sm:col-span-2">
        <button className="rounded-2xl bg-sky-400 px-5 py-3 font-medium text-slate-950 transition hover:bg-sky-300" type="submit">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function MarginSummary({
  marginState,
  marginAvailable,
  requiredMargin,
  orderMargin,
  insufficientFunds,
  isWithinMargin,
  productCode,
  indicativeMisMargin,
}) {
  if (marginState.state === "idle") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 text-sm text-slate-300">
        <div className="font-medium text-white">Available margin: {formatCurrencyLike(marginAvailable)}</div>
        <div className="mt-1 text-slate-400">Add symbol, quantity, and price details to check required margin.</div>
      </div>
    );
  }

  if (marginState.state === "loading") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 text-sm text-slate-300">
        Checking required margin...
      </div>
    );
  }

  if (marginState.state === "error") {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-100">
        {marginState.error}
      </div>
    );
  }

  const tone = isWithinMargin
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-100";

  return (
    <div className={`rounded-2xl border px-4 py-4 ${tone}`}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-medium">
          {isWithinMargin ? "Margin available for this order." : "Required margin exceeds available funds."}
        </div>
        <div className="text-xs uppercase tracking-[0.2em]">
          {marginState.data?.rmsVldtd ?? "--"}
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MarginValue label="Available" value={formatCurrencyLike(marginAvailable)} />
        <MarginValue label="Required" value={formatCurrencyLike(requiredMargin)} />
        <MarginValue label="Order Margin" value={formatCurrencyLike(orderMargin)} />
        <MarginValue label="Shortfall" value={formatCurrencyLike(insufficientFunds)} />
      </div>
      {productCode === "MIS" && (
        <div className="mt-3 text-xs text-slate-200/90">
          MIS is shown with 5x leverage context. Indicative MIS margin on order value: {formatCurrencyLike(indicativeMisMargin)}.
          Final validation still comes from Kotak margin check.
        </div>
      )}
    </div>
  );
}

function MarginValue({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/30 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-300">{label}</div>
      <div className="mt-2 text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-2 text-sm text-slate-300">
      {label}
      {children}
    </label>
  );
}

function SegmentedFilter({ value, onChange, options }) {
  return (
    <div className="flex rounded-2xl border border-slate-800 bg-slate-950/70 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
            value === option.value
              ? "bg-sky-400 text-slate-950"
              : "text-slate-300 hover:bg-white/5"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DetailsBadge({ details }) {
  const visibleDetails = details.filter(([, value]) => value !== "--" && value !== null && value !== undefined && value !== "");

  return (
    <details className="group relative inline-flex">
      <summary className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full border border-slate-700 text-xs text-slate-200 transition marker:hidden group-hover:border-sky-400 group-hover:text-sky-300">
        i
      </summary>
      <div className="absolute right-0 top-10 z-20 hidden w-72 rounded-2xl border border-slate-700 bg-slate-950/95 p-4 text-xs shadow-2xl group-open:block group-hover:block">
        <div className="grid gap-2">
          {visibleDetails.map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-3">
              <span className="text-slate-400">{label}</span>
              <span className="text-right text-slate-100">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function MetricChip({ label, value, tone = "text-white" }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`mt-2 text-sm font-medium ${tone}`}>{value}</div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className="mt-2 break-all text-sm font-medium text-white">{value}</div>
    </div>
  );
}

function PnlSummary({ summary, updatedAt }) {
  const data = summary ?? {
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    openPositions: 0,
    closedPositions: 0,
  };

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <PnlStat label="Realized" value={data.realizedPnl} />
        <PnlStat label="Unrealized" value={data.unrealizedPnl} />
        <PnlStat label="Total" value={data.totalPnl} strong />
        <Stat label="Open Positions" value={String(data.openPositions)} />
        <Stat label="Closed Today" value={String(data.closedPositions)} />
        <Stat label="Updated" value={updatedAt ? new Date(updatedAt).toLocaleTimeString() : "--"} />
      </div>
      <div className="mt-4 text-sm text-slate-400">
        Realized P&L is derived from matched intraday buy/sell quantities. Unrealized P&L uses current LTP for net open quantity.
      </div>
    </div>
  );
}

function PnlStat({ label, value, strong = false }) {
  const tone =
    value > 0
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
      : value < 0
        ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
        : "border-slate-800 bg-slate-950/70 text-white";

  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="text-xs uppercase tracking-[0.2em] text-slate-300">{label}</div>
      <div className={`mt-2 text-sm ${strong ? "font-semibold" : "font-medium"}`}>{formatSignedCurrency(value)}</div>
    </div>
  );
}

function PnlTable({ rows }) {
  const [filter, setFilter] = useState("active");
  const normalizedRows = [...rows]
    .filter((row) => {
      if (filter === "active") {
        return Number(row.netQuantity ?? 0) !== 0;
      }
      if (filter === "closed") {
        return Number(row.netQuantity ?? 0) === 0;
      }
      return true;
    })
    .sort((left, right) => (right.totalPnl ?? 0) - (left.totalPnl ?? 0));

  return (
    <section className="min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Position P&amp;L</h2>
        <div className="flex items-center gap-3">
          <SegmentedFilter
            value={filter}
            onChange={setFilter}
            options={[
              { value: "active", label: "Active" },
              { value: "closed", label: "Closed" },
              { value: "all", label: "All" },
            ]}
          />
          <div className="text-xs uppercase tracking-[0.22em] text-slate-500">{normalizedRows.length} rows</div>
        </div>
      </div>

      {!normalizedRows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          No position P&amp;L rows returned.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-950/80 text-left text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Net Qty</th>
                  <th className="px-4 py-3 font-medium">Avg Open</th>
                  <th className="px-4 py-3 font-medium">LTP</th>
                  <th className="px-4 py-3 font-medium">Profit</th>
                  <th className="px-4 py-3 font-medium">State</th>
                  <th className="px-4 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/50 text-slate-200">
                {normalizedRows.map((row, index) => (
                  <tr key={`${row.symbol}-${row.product}-${index}`}>
                    <td className="px-4 py-3">{row.symbol}</td>
                    <td className="px-4 py-3">{row.product}</td>
                    <td className="px-4 py-3">{formatNumber(row.netQuantity)}</td>
                    <td className="px-4 py-3">{formatCurrencyLike(row.openAverage)}</td>
                    <td className="px-4 py-3">{formatCurrencyLike(row.ltp)}</td>
                    <td className={`px-4 py-3 font-medium ${pnlToneClass(row.totalPnl)}`}>{formatSignedCurrency(row.totalPnl)}</td>
                    <td className="px-4 py-3">{Number(row.netQuantity ?? 0) === 0 ? "Closed" : "Active"}</td>
                    <td className="px-4 py-3">
                      <DetailsBadge
                        details={[
                          ["Realized", formatSignedCurrency(row.realizedPnl)],
                          ["Unrealized", formatSignedCurrency(row.unrealizedPnl)],
                          ["Buy Qty", formatNumber(row.buyQuantity)],
                          ["Sell Qty", formatNumber(row.sellQuantity)],
                          ["Buy Amt", formatCurrencyLike(row.buyAmount)],
                          ["Sell Amt", formatCurrencyLike(row.sellAmount)],
                          ["Quote", row.quoteFound ? "Live" : "Missing"],
                          ["Updated", formatUpdateTime(row.lastUpdated)],
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function DataTable({ title, rows, emptyText, actions, compact = false }) {
  const columns = rows.length ? Object.keys(rows[0]).slice(0, 8) : [];

  return (
    <section className={compact ? "min-w-0" : "min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur"}>
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <div className="text-xs uppercase tracking-[0.22em] text-slate-500">{rows.length} rows</div>
      </div>

      {!rows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-950/80 text-left text-slate-300">
                <tr>
                  {columns.map((column) => (
                    <th key={column} className="px-4 py-3 font-medium whitespace-nowrap">
                      {column}
                    </th>
                  ))}
                  {actions && <th className="px-4 py-3 font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/50 text-slate-200">
                {rows.map((row, index) => (
                  <tr key={`${title}-${index}`}>
                    {columns.map((column) => (
                      <td key={column} className="max-w-56 px-4 py-3 align-top">
                        <span className="block truncate">{formatCell(row[column])}</span>
                      </td>
                    ))}
                    {actions && <td className="px-4 py-3">{actions(row)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function OrderBookTable({ rows, onEdit, onCancel, onHistory, busyAction }) {
  const normalizedRows = rows.map(normalizeOrderRow);

  return (
    <section className="min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Order Book</h2>
        <div className="text-xs uppercase tracking-[0.22em] text-slate-500">{normalizedRows.length} rows</div>
      </div>

      {!normalizedRows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          No order data loaded.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-950/80 text-left text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-medium">Order No</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium">Side</th>
                  <th className="px-4 py-3 font-medium">Qty</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Avg Price</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/50 text-slate-200">
                {normalizedRows.map((row) => (
                  <tr key={row.orderNo}>
                    <td className="px-4 py-3">{row.orderNo}</td>
                    <td className="px-4 py-3">{row.status}</td>
                    <td className="px-4 py-3">{row.symbol}</td>
                    <td className="px-4 py-3">{row.side}</td>
                    <td className="px-4 py-3">{row.quantity}</td>
                    <td className="px-4 py-3">{row.price}</td>
                    <td className="px-4 py-3">{row.avgPrice}</td>
                    <td className="px-4 py-3">{row.priceType}</td>
                    <td className="px-4 py-3">{row.product}</td>
                    <td className="px-4 py-3">{row.time}</td>
                    <td className="max-w-56 px-4 py-3">
                      <span className="block truncate">{row.reason}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {row.canEdit && (
                          <button className="rounded-xl border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-sky-400" type="button" onClick={() => onEdit(row.raw)}>
                            Edit
                          </button>
                        )}
                        <button className="rounded-xl border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-sky-400 disabled:opacity-50" type="button" onClick={() => onHistory(row.orderNo)} disabled={busyAction === `history-${row.orderNo}`}>
                          {busyAction === `history-${row.orderNo}` ? "Loading..." : "History"}
                        </button>
                        {row.canCancel && (
                          <button className="rounded-xl border border-rose-500/40 px-3 py-1 text-xs text-rose-200 hover:border-rose-400 disabled:opacity-50" type="button" onClick={() => onCancel(row.orderNo)} disabled={!row.orderNo || busyAction === `cancel-${row.orderNo}`}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function OrderHistoryPanel({ orderNo, rows }) {
  const normalizedRows = rows.map(normalizeOrderHistoryRow);

  return (
    <section className="min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Order History</h2>
        <div className="text-xs uppercase tracking-[0.22em] text-slate-500">{orderNo || "No order selected"}</div>
      </div>

      {!orderNo ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          Select `History` on an order to fetch its lifecycle updates.
        </div>
      ) : !normalizedRows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          No history rows returned for this order.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-950/80 text-left text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Qty</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Avg Price</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/50 text-slate-200">
                {normalizedRows.map((row, index) => (
                  <tr key={`${row.time}-${index}`}>
                    <td className="px-4 py-3">{row.time}</td>
                    <td className="px-4 py-3">{row.status}</td>
                    <td className="px-4 py-3">{row.quantity}</td>
                    <td className="px-4 py-3">{row.price}</td>
                    <td className="px-4 py-3">{row.avgPrice}</td>
                    <td className="px-4 py-3">{row.priceType}</td>
                    <td className="px-4 py-3">{row.product}</td>
                    <td className="max-w-72 px-4 py-3">
                      <span className="block truncate">{row.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function PositionsTable({ rows, pnlRows = [] }) {
  const [filter, setFilter] = useState("active");
  const pnlMap = new Map(
    pnlRows.map((row) => [buildPositionKey(row.symbol, row.product, row.exchange), row]),
  );
  const normalizedRows = rows
    .map((row) => normalizePositionDisplayRow(row, pnlMap))
    .filter((row) => {
      if (filter === "active") {
        return row.isOpen === "Yes";
      }
      if (filter === "closed") {
        return row.isOpen !== "Yes";
      }
      return true;
    });

  return (
    <section className="min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Positions</h2>
        <div className="flex items-center gap-3">
          <SegmentedFilter
            value={filter}
            onChange={setFilter}
            options={[
              { value: "active", label: "Active" },
              { value: "closed", label: "Closed" },
              { value: "all", label: "All" },
            ]}
          />
          <div className="text-xs uppercase tracking-[0.22em] text-slate-500">{normalizedRows.length} rows</div>
        </div>
      </div>

      {!normalizedRows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          No positions returned.
        </div>
      ) : (
        <div className="grid gap-3">
          {normalizedRows.map((row, index) => (
            <article
              key={`${row.symbol}-${row.product}-${row.exchange}-${index}`}
              className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-white">{row.symbol}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                    <span>{row.product}</span>
                    <span>{row.exchange}</span>
                    <span>{row.isOpen === "Yes" ? "Active" : "Closed"}</span>
                  </div>
                </div>
                <DetailsBadge
                  details={[
                    ["Exchange", row.exchange],
                    ["Buy Qty", row.buyQuantity],
                    ["Sell Qty", row.sellQuantity],
                    ["Buy Amt", row.buyAmount],
                    ["Sell Amt", row.sellAmount],
                    ["Realized", row.realizedPnl],
                    ["Unrealized", row.unrealizedPnl],
                    ["Square Off", row.squareOffAllowed],
                    ["Lot Size", row.lotSize],
                    ["Updated", row.updatedAt],
                  ]}
                />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricChip label="Net Qty" value={row.netQuantity} />
                <MetricChip label="Avg Open" value={row.avgOpenPrice} />
                <MetricChip label="LTP" value={row.ltp} />
                <MetricChip label="Profit" value={row.totalPnl} tone={pnlToneClass(row.totalPnlValue)} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function TradesTable({ rows }) {
  const normalizedRows = rows.map(normalizeTradeDisplayRow);

  return (
    <section className="min-w-0 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/20 backdrop-blur">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Trades</h2>
        <div className="text-xs uppercase tracking-[0.22em] text-slate-500">{normalizedRows.length} rows</div>
      </div>

      {!normalizedRows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
          No trades returned.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-950/80 text-left text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-medium">Order No</th>
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium">Side</th>
                  <th className="px-4 py-3 font-medium">Qty</th>
                  <th className="px-4 py-3 font-medium">Filled Qty</th>
                  <th className="px-4 py-3 font-medium">Avg Price</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                  <th className="px-4 py-3 font-medium">Trade Date</th>
                  <th className="px-4 py-3 font-medium">Exchange Time</th>
                  <th className="px-4 py-3 font-medium">Exchange Order ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/50 text-slate-200">
                {normalizedRows.map((row, index) => (
                  <tr key={`${row.orderNo}-${row.exchangeTime}-${index}`}>
                    <td className="px-4 py-3">{row.orderNo}</td>
                    <td className="px-4 py-3">{row.symbol}</td>
                    <td className="px-4 py-3">{row.side}</td>
                    <td className="px-4 py-3">{row.quantity}</td>
                    <td className="px-4 py-3">{row.filledQuantity}</td>
                    <td className="px-4 py-3">{row.avgPrice}</td>
                    <td className="px-4 py-3">{row.priceType}</td>
                    <td className="px-4 py-3">{row.product}</td>
                    <td className="px-4 py-3">{row.duration}</td>
                    <td className="px-4 py-3">{row.tradeDate}</td>
                    <td className="px-4 py-3">{row.exchangeTime}</td>
                    <td className="px-4 py-3">{row.exchangeOrderId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

const inputClassName =
  "rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400";

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? tryParseJson(text) : {};

  if (!response.ok) {
    throw new Error(getErrorMessage(data));
  }

  return data;
}

function toRows(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.filter(isPlainObject);
  }

  if (Array.isArray(payload.data)) {
    return payload.data.filter(isPlainObject);
  }

  if (isPlainObject(payload.data)) {
    const nestedArray = Object.values(payload.data).find(Array.isArray);
    if (nestedArray) {
      return nestedArray.filter(isPlainObject);
    }
  }

  if (isPlainObject(payload)) {
    const nestedArray = Object.values(payload).find(Array.isArray);
    if (nestedArray) {
      return nestedArray.filter(isPlainObject);
    }
    return [payload];
  }

  return [];
}

function flattenObject(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const flat = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isPlainObject(nested)) {
      for (const [innerKey, innerValue] of Object.entries(nested)) {
        flat[`${key}.${innerKey}`] = innerValue;
      }
    } else {
      flat[key] = nested;
    }
  }
  return flat;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatCell(value) {
  if (value === null || value === undefined) {
    return "--";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function canCheckMargin(form) {
  if (!form || !form.symbol?.trim() || !form.exchangeSegment || !form.productCode || !form.quantity) {
    return false;
  }

  if (toNumber(form.quantity) === null || toNumber(form.quantity) <= 0) {
    return false;
  }

  if ((form.priceType === "L" || form.priceType === "SL") && toNumber(form.price) === null) {
    return false;
  }

  if (form.productCode === "CO" && toNumber(form.triggerPrice) === null) {
    return false;
  }

  if (form.productCode === "BO") {
    return toNumber(form.squareOffValue) !== null && toNumber(form.stopLossValue) !== null;
  }

  return true;
}

function pickMarginAvailable(marginData, limits) {
  const apiAvailable = toNumber(marginData?.avlMrgn) ?? toNumber(marginData?.avlCash);
  if (apiAvailable !== null && apiAvailable > 0) {
    return apiAvailable;
  }

  return (
    toNumber(limits?.Net) ??
    apiAvailable ??
    toNumber(marginData?.avlMrgn) ??
    toNumber(marginData?.avlCash) ??
    toNumber(limits?.CollateralValue) ??
    0
  );
}

function pickRequiredMargin(marginData) {
  const requiredMargin = toNumber(marginData?.reqdMrgn);
  if (requiredMargin !== null && requiredMargin > 0) {
    return requiredMargin;
  }

  return (
    toNumber(marginData?.ordMrgn) ??
    requiredMargin ??
    0
  );
}

function pickMarginShortfall(marginData, marginAvailable, requiredMargin) {
  const apiShortfall = toNumber(marginData?.insufFund);
  if (apiShortfall !== null && apiShortfall > 0) {
    return apiShortfall;
  }

  if (marginAvailable !== null && requiredMargin !== null) {
    return Math.max(requiredMargin - marginAvailable, 0);
  }

  return (
    apiShortfall ??
    0
  );
}

function pickIndicativeMisMargin({ notionalValue, orderMargin }) {
  if (notionalValue > 0) {
    return notionalValue / 5;
  }

  return orderMargin;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrencyLike(value) {
  if (value === null || value === undefined) {
    return "--";
  }

  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(value) {
  if (value === null || value === undefined) {
    return "--";
  }

  const absolute = Math.abs(Number(value));
  const prefix = Number(value) > 0 ? "+" : Number(value) < 0 ? "-" : "";
  return `${prefix}${absolute.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "--";
  }

  return Number(value).toLocaleString("en-IN", {
    maximumFractionDigits: 4,
  });
}

function formatUpdateTime(value) {
  if (!value || value === "--") {
    return "--";
  }

  if (/^\d+$/.test(String(value))) {
    return new Date(Number(value) * 1000).toLocaleTimeString();
  }

  return String(value);
}

function pnlToneClass(value) {
  if (value > 0) {
    return "text-emerald-300";
  }
  if (value < 0) {
    return "text-rose-300";
  }
  return "text-slate-200";
}

function normalizeOrderRow(row) {
  const status = String(row.ordSt ?? row.status ?? "").trim();
  const normalizedStatus = normalizeStatus(status);
  const product = String(row.prod ?? row.pc ?? "--");

  return {
    orderNo: String(row.nOrdNo ?? row.orderNo ?? row.no ?? "--"),
    status: status || "--",
    symbol: String(row.trdSym ?? row.ts ?? row.symbol ?? "--"),
    side: normalizeSide(row.trnsTp ?? row.tt),
    quantity: String(row.qty ?? row.qt ?? "--"),
    price: String(row.prc ?? row.pr ?? "--"),
    avgPrice: String(row.avgPrc ?? "--"),
    priceType: String(row.prcTp ?? row.pt ?? "--"),
    product,
    time: String(row.ordDtTm ?? "--"),
    reason: String(row.rejRsn ?? "--"),
    canCancel: isCancelableOrderState(normalizedStatus, product),
    canEdit: isEditableOrderState(normalizedStatus, product),
    raw: row,
  };
}

function normalizeOrderHistoryRow(row) {
  return {
    time: String(row.flDtTm ?? row.ordDtTm ?? "--"),
    status: String(row.ordSt ?? "--"),
    quantity: String(row.qty ?? "--"),
    price: String(row.prc ?? "--"),
    avgPrice: String(row.avgPrc ?? "--"),
    priceType: String(row.prcTp ?? "--"),
    product: String(row.prod ?? "--"),
    reason: String(row.rejRsn ?? "--"),
  };
}

function normalizePositionRow(row) {
  return {
    actId: String(row.actId ?? ""),
    exSeg: String(row.exSeg ?? ""),
    prod: String(row.prod ?? ""),
    trdSym: String(row.trdSym ?? row.sym ?? ""),
    sym: String(row.sym ?? ""),
  };
}

function normalizePositionDisplayRow(row, pnlMap = new Map()) {
  const pnl = pnlMap.get(
    buildPositionKey(
      String(row.trdSym ?? row.sym ?? "--"),
      String(row.prod ?? "--"),
      String(row.exSeg ?? "--"),
    ),
  );
  const rawNetQuantity = toNumber(row.qty);
  const derivedNetQuantity =
    rawNetQuantity ??
    (() => {
      const buyQuantity = toNumber(row.flBuyQty);
      const sellQuantity = toNumber(row.flSellQty);
      if (buyQuantity === null && sellQuantity === null) {
        return null;
      }
      return (buyQuantity ?? 0) - (sellQuantity ?? 0);
    })();
  const isOpen = derivedNetQuantity !== null
    ? derivedNetQuantity !== 0
    : row.posFlg === "true" || row.posFlg === true;

  return {
    symbol: String(row.trdSym ?? row.sym ?? "--"),
    product: String(row.prod ?? "--"),
    exchange: String(row.exSeg ?? "--"),
    netQuantity: formatNumber(derivedNetQuantity),
    buyQuantity: String(row.flBuyQty ?? "--"),
    sellQuantity: String(row.flSellQty ?? "--"),
    buyAmount: String(row.buyAmt ?? "--"),
    sellAmount: String(row.sellAmt ?? "--"),
    isOpen: isOpen ? "Yes" : "No",
    squareOffAllowed: row.sqrFlg === "Y" ? "Yes" : "No",
    lotSize: String(row.lotSz ?? row.brdLtQty ?? "--"),
    updatedAt: String(row.hsUpTm ?? "--"),
    avgOpenPrice: formatCurrencyLike(pnl?.openAverage ?? null),
    ltp: formatCurrencyLike(pnl?.ltp ?? null),
    totalPnl: formatSignedCurrency(pnl?.totalPnl ?? 0),
    totalPnlValue: Number(pnl?.totalPnl ?? 0),
    realizedPnl: formatSignedCurrency(pnl?.realizedPnl ?? 0),
    unrealizedPnl: formatSignedCurrency(pnl?.unrealizedPnl ?? 0),
  };
}

function normalizeTradeDisplayRow(row) {
  return {
    orderNo: String(row.nOrdNo ?? "--"),
    symbol: String(row.trdSym ?? "--"),
    side: normalizeSide(row.trnsTp),
    quantity: String(row.qty ?? "--"),
    filledQuantity: String(row.fldQty ?? "--"),
    avgPrice: String(row.avgPrc ?? "--"),
    priceType: String(row.prcTp ?? "--"),
    product: String(row.prod ?? "--"),
    duration: String(row.ordDur ?? "--"),
    tradeDate: String(row.flDt ?? "--"),
    exchangeTime: String(row.exTm ?? "--"),
    exchangeOrderId: String(row.exOrdId ?? "--"),
  };
}

function buildPositionKey(symbol, product, exchange) {
  return [symbol, product, exchange].map((value) => String(value ?? "").trim().toLowerCase()).join("|");
}

function isSamePosition(left, right) {
  const normalizedLeft = normalizePositionRow(left);
  const normalizedRight = normalizePositionRow(right);

  return (
    normalizedLeft.actId === normalizedRight.actId &&
    normalizedLeft.exSeg === normalizedRight.exSeg &&
    normalizedLeft.prod === normalizedRight.prod &&
    (normalizedLeft.trdSym === normalizedRight.trdSym ||
      normalizedLeft.sym === normalizedRight.sym)
  );
}

function normalizeSide(value) {
  if (value === "B") {
    return "Buy";
  }
  if (value === "S") {
    return "Sell";
  }
  return String(value ?? "--");
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ");
}

function isCancelableOrderState(status, product) {
  if (!status) {
    return false;
  }

  if (isTerminalOrderState(status)) {
    return false;
  }

  if (product === "BO" || product === "CO") {
    return true;
  }

  return (
    status.includes("open") ||
    status.includes("pending") ||
    status.includes("trigger") ||
    status.includes("req received") ||
    status.includes("request received") ||
    status.includes("validation")
  );
}

function isEditableOrderState(status, product) {
  if (!status) {
    return false;
  }

  if (product === "BO" || product === "CO") {
    return false;
  }

  if (isTerminalOrderState(status)) {
    return false;
  }

  return (
    status.includes("open") ||
    status.includes("pending") ||
    status.includes("trigger pending") ||
    status.includes("validation")
  );
}

function isTerminalOrderState(status) {
  return (
    status.includes("complete") ||
    status.includes("completed") ||
    status.includes("rejected") ||
    status.includes("cancel") ||
    status.includes("expired") ||
    status.includes("traded")
  );
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function getErrorMessage(data) {
  if (!data) {
    return "Request failed";
  }

  const candidate =
    data.error ??
    data.message ??
    data.emsg ??
    data.msg ??
    data.raw ??
    "Request failed";

  if (typeof candidate === "string") {
    return candidate;
  }

  if (candidate && typeof candidate === "object") {
    const nested =
      candidate.message ??
      candidate.error ??
      candidate.emsg ??
      candidate.msg ??
      candidate.raw;

    if (typeof nested === "string") {
      return nested;
    }

    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  return String(candidate);
}

export default App;
