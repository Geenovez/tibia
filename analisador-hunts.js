(function (global) {
  const STORE_KEY = "tibiaTools:huntAnalyzer";
  const UNKNOWN_PLAYER = "Jogador";
  const UNKNOWN_HUNT = "Hunt sem nome";

  const METRIC_MAP = {
    "Raw XP Gain": "rawXpGain",
    "XP Gain": "xpGain",
    "Raw XP/h": "rawXpH",
    "XP/h": "xpH",
    Loot: "loot",
    Supplies: "supplies",
    Balance: "balance",
    Damage: "damage",
    "Damage/h": "damageH",
    Healing: "healing",
    "Healing/h": "healingH"
  };

  function normalizeName(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function titleName(value) {
    return normalizeName(value).replace(/\b\p{L}/gu, c => c.toLocaleUpperCase("pt-BR"));
  }

  function parseInteger(value) {
    if (value === null || value === undefined) return 0;
    const clean = String(value).replace(/[^\d-]/g, "");
    if (!clean || clean === "-") return 0;
    return Number(clean);
  }

  function parseSessionMinutes(value) {
    const match = normalizeName(value).match(/(\d{1,3}):([0-5]\d)h/i);
    if (!match) return 0;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function parseLogTimestamp(value) {
    const match = normalizeName(value).match(/^(\d{4})-(\d{2})-(\d{2}),\s*(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }

  function minutesBetween(start, end) {
    const from = parseLogTimestamp(start);
    const to = parseLogTimestamp(end);
    if (from === null || to === null || to <= from) return 0;
    return (to - from) / 60000;
  }

  function formatInteger(value) {
    return Math.round(value || 0).toLocaleString("pt-BR");
  }

  function formatDecimal(value, digits = 1) {
    return (value || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function formatGold(value) {
    const rounded = Math.round(value || 0);
    if (Math.abs(rounded) >= 1000000) {
      return formatDecimal(rounded / 1000000, 2).replace(/,00$/, "") + "kk";
    }
    if (Math.abs(rounded) >= 1000) {
      return formatDecimal(rounded / 1000, 1).replace(/,0$/, "") + "k";
    }
    return rounded.toLocaleString("pt-BR");
  }

  function formatDuration(minutes) {
    const safe = Math.max(0, Math.round(minutes || 0));
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    if (hours === 0) return `${mins}min`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h${String(mins).padStart(2, "0")}min`;
  }

  function splitBlocks(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const blocks = [];
    let current = [];

    lines.forEach(line => {
      const startsBlock = /Session data:/i.test(line);
      if (startsBlock && current.some(l => l.trim())) {
        blocks.push(current);
        current = [];
      }
      if (line.trim() || current.length) current.push(line);
    });

    if (current.some(line => line.trim())) blocks.push(current);
    return blocks.filter(block => block.some(line => /Session data:|Session:|Killed Monsters:/i.test(line)));
  }

  function detectMessagePrefix(line) {
    const match = line.match(/^\[[^\]]+\]\s*([^:]+):\s*(.*)$/);
    if (!match) return null;
    return {
      player: normalizeName(match[1]),
      rest: match[2]
    };
  }

  function makeHuntFromMonsters(monsters, fallback) {
    const names = Object.keys(monsters || {});
    if (fallback) return normalizeName(fallback);
    if (!names.length) return UNKNOWN_HUNT;
    return names
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 4)
      .map(titleName)
      .join(" / ");
  }

  function makeHuntKey(monsters, huntName) {
    if (huntName && huntName !== UNKNOWN_HUNT) return "name:" + huntName.toLocaleLowerCase("pt-BR");
    const names = Object.keys(monsters || {}).sort((a, b) => a.localeCompare(b));
    return names.length ? "monsters:" + names.join("|") : "unknown";
  }

  function addCount(target, name, count) {
    const key = normalizeName(name).toLocaleLowerCase("pt-BR");
    if (!key) return;
    target[key] = (target[key] || 0) + count;
  }

  function parseBlock(lines, options = {}) {
    const session = {
      player: normalizeName(options.defaultPlayer) || UNKNOWN_PLAYER,
      hunt: "",
      huntKey: "",
      start: "",
      end: "",
      minutes: 0,
      metrics: {},
      monsters: {},
      items: {},
      warnings: []
    };

    let mode = "";
    let hasNamedHunt = false;

    lines.forEach((originalLine, index) => {
      let line = originalLine;
      if (index === 0) {
        const prefix = detectMessagePrefix(line);
        if (prefix) {
          session.player = prefix.player || session.player;
          line = prefix.rest;
        }
      }

      const trimmed = line.trim();
      if (!trimmed) return;

      const dataMatch = trimmed.match(/Session data:\s*From\s+(.+?)\s+to\s+(.+)$/i);
      if (dataMatch) {
        session.start = normalizeName(dataMatch[1]);
        session.end = normalizeName(dataMatch[2]);
        session.minutes = minutesBetween(session.start, session.end) || session.minutes;
        mode = "";
        return;
      }

      const huntMatch = trimmed.match(/^(Hunt|Hunt name|Local|Localização|Lugar):\s*(.+)$/i);
      if (huntMatch) {
        session.hunt = normalizeName(huntMatch[2]);
        hasNamedHunt = true;
        mode = "";
        return;
      }

      const playerMatch = trimmed.match(/^(Player|Jogador):\s*(.+)$/i);
      if (playerMatch) {
        session.player = normalizeName(playerMatch[2]) || session.player;
        mode = "";
        return;
      }

      const sessionMatch = trimmed.match(/^Session:\s*(.+)$/i);
      if (sessionMatch) {
        session.minutes = session.minutes || parseSessionMinutes(sessionMatch[1]);
        mode = "";
        return;
      }

      if (/^Killed Monsters:/i.test(trimmed)) {
        mode = "monsters";
        return;
      }

      if (/^Looted Items:/i.test(trimmed)) {
        mode = "items";
        return;
      }

      const metricMatch = trimmed.match(/^([A-Za-z/ ]+):\s*(-?[\d.,]+)/);
      if (metricMatch) {
        const label = normalizeName(metricMatch[1]);
        const key = METRIC_MAP[label];
        if (key) session.metrics[key] = parseInteger(metricMatch[2]);
        mode = "";
        return;
      }

      const listMatch = trimmed.match(/^(\d+)x\s+(.+)$/i);
      if (listMatch && mode) {
        const count = Number(listMatch[1]);
        const name = listMatch[2];
        if (mode === "monsters") addCount(session.monsters, name, count);
        if (mode === "items") addCount(session.items, name, count);
      }
    });

    if (!session.hunt && options.defaultHunt) {
      session.hunt = normalizeName(options.defaultHunt);
      hasNamedHunt = true;
    }

    const sessionHours = session.minutes / 60;
    if (sessionHours > 0) {
      if (!session.metrics.xpGain && session.metrics.xpH) session.metrics.xpGain = session.metrics.xpH * sessionHours;
      if (!session.metrics.rawXpGain && session.metrics.rawXpH) session.metrics.rawXpGain = session.metrics.rawXpH * sessionHours;
      if (!session.metrics.damage && session.metrics.damageH) session.metrics.damage = session.metrics.damageH * sessionHours;
      if (!session.metrics.healing && session.metrics.healingH) session.metrics.healing = session.metrics.healingH * sessionHours;
    }
    if (!session.metrics.balance && (session.metrics.loot || session.metrics.supplies)) {
      session.metrics.balance = (session.metrics.loot || 0) - (session.metrics.supplies || 0);
    }

    session.hunt = makeHuntFromMonsters(session.monsters, session.hunt);
    session.huntKey = hasNamedHunt ? makeHuntKey(session.monsters, session.hunt) : makeHuntKey(session.monsters, "");

    if (!session.minutes) session.warnings.push("Sessão sem duração válida.");
    if (!Object.keys(session.monsters).length) session.warnings.push("Sessão sem monstros.");
    if (!session.metrics.xpGain && !session.metrics.xpH) session.warnings.push("Sessão sem XP.");

    return session;
  }

  function parseLogs(text, options = {}) {
    return splitBlocks(text)
      .map(block => parseBlock(block, options))
      .filter(session => session.minutes > 0);
  }

  function createAggregate(hunt, huntKey, player) {
    return {
      hunt,
      huntKey,
      player,
      sessions: 0,
      minutes: 0,
      metrics: {
        rawXpGain: 0,
        xpGain: 0,
        loot: 0,
        supplies: 0,
        balance: 0,
        damage: 0,
        healing: 0
      },
      monsters: {},
      items: {}
    };
  }

  function addMap(target, source) {
    Object.keys(source || {}).forEach(key => {
      target[key] = (target[key] || 0) + source[key];
    });
  }

  function addSessionToAggregate(aggregate, session) {
    aggregate.sessions += 1;
    aggregate.minutes += session.minutes;
    Object.keys(aggregate.metrics).forEach(key => {
      aggregate.metrics[key] += session.metrics[key] || 0;
    });
    addMap(aggregate.monsters, session.monsters);
    addMap(aggregate.items, session.items);
  }

  function aggregateSessions(sessions, byPlayer = true) {
    const map = new Map();
    sessions.forEach(session => {
      const player = byPlayer ? session.player : "Todos";
      const key = `${session.huntKey}::${player}`;
      if (!map.has(key)) map.set(key, createAggregate(session.hunt, session.huntKey, player));
      addSessionToAggregate(map.get(key), session);
    });
    return [...map.values()].sort((a, b) => {
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      return a.hunt.localeCompare(b.hunt) || a.player.localeCompare(b.player);
    });
  }

  function totalAggregate(sessions) {
    const aggregate = createAggregate("Todas", "all", "Todos");
    sessions.forEach(session => addSessionToAggregate(aggregate, session));
    return aggregate;
  }

  function hours(aggregateOrSession) {
    return (aggregateOrSession.minutes || 0) / 60;
  }

  function perHour(total, aggregateOrSession) {
    const h = hours(aggregateOrSession);
    return h > 0 ? total / h : 0;
  }

  function totalKills(value) {
    return Object.values(value.monsters || {}).reduce((sum, count) => sum + count, 0);
  }

  function filteredSessions(sessions, huntKey, player) {
    return sessions.filter(session => {
      const huntOk = huntKey === "all" || session.huntKey === huntKey;
      const playerOk = player === "all" || session.player === player;
      return huntOk && playerOk;
    });
  }

  const Core = {
    parseLogs,
    aggregateSessions,
    totalAggregate,
    filteredSessions,
    perHour,
    totalKills,
    formatInteger,
    formatDecimal,
    formatGold,
    formatDuration,
    titleName
  };

  function init() {
    const $ = id => document.getElementById(id);
    const logInput = $("logInput");
    const defaultHunt = $("defaultHunt");
    const analyzeBtn = $("analyzeBtn");
    const clearBtn = $("clearBtn");
    const huntFilter = $("huntFilter");
    const status = $("status");
    const summaryTag = $("summaryTag");
    const summaryBody = $("summaryBody");
    const monsterBody = $("monsterBody");
    const itemBody = $("itemBody");
    const sessionBody = $("sessionBody");
    const summaryEmpty = $("summaryEmpty");
    const monsterEmpty = $("monsterEmpty");
    const itemEmpty = $("itemEmpty");
    const sessionEmpty = $("sessionEmpty");

    const summaryEls = {
      xpH: $("sumXpH"),
      xpExplain: $("sumXpExplain"),
      balanceH: $("sumBalanceH"),
      sessions: $("sumSessions"),
      time: $("sumTime"),
      killsH: $("sumKillsH"),
      lootH: $("sumLootH"),
      suppliesH: $("sumSuppliesH"),
      damageH: $("sumDamageH")
    };

    let sessions = [];

    function saveState() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          logs: logInput.value,
          defaultHunt: defaultHunt.value
        }));
      } catch (e) {}
    }

    function restoreState() {
      try {
        const stored = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
        if (!stored) return;
        if (typeof stored.logs === "string") logInput.value = stored.logs;
        if (typeof stored.defaultHunt === "string") defaultHunt.value = stored.defaultHunt;
      } catch (e) {}
    }

    function option(value, label) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      return opt;
    }

    function refreshFilters(previousHunt = "all") {
      const hunts = new Map();

      sessions.forEach(session => {
        if (!hunts.has(session.huntKey)) hunts.set(session.huntKey, session.hunt);
      });

      huntFilter.innerHTML = "";
      huntFilter.appendChild(option("all", "Todas"));
      [...hunts.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .forEach(([key, label]) => huntFilter.appendChild(option(key, label)));

      huntFilter.value = hunts.has(previousHunt) ? previousHunt : "all";
    }

    function setEmpty(isEmpty) {
      summaryEmpty.style.display = isEmpty ? "" : "none";
      monsterEmpty.style.display = isEmpty ? "" : "none";
      itemEmpty.style.display = isEmpty ? "" : "none";
      sessionEmpty.style.display = isEmpty ? "" : "none";
    }

    function clearTables() {
      summaryBody.innerHTML = "";
      monsterBody.innerHTML = "";
      itemBody.innerHTML = "";
      sessionBody.innerHTML = "";
    }

    function renderSummary(filtered) {
      const total = totalAggregate(filtered);
      const xpTotal = total.metrics.xpGain || 0;
      const rawXpTotal = total.metrics.rawXpGain || 0;
      const balancePerHour = perHour(total.metrics.balance, total);
      const kills = totalKills(total);

      summaryEls.xpH.textContent = filtered.length ? formatInteger(perHour(xpTotal, total)) : "--";
      summaryEls.balanceH.textContent = filtered.length ? formatGold(balancePerHour) : "--";
      summaryEls.balanceH.className = "big " + (balancePerHour >= 0 ? "ok" : "bad");
      summaryEls.sessions.textContent = filtered.length ? formatInteger(total.sessions) : "--";
      summaryEls.time.textContent = filtered.length ? formatDuration(total.minutes) : "--";
      summaryEls.killsH.textContent = filtered.length ? formatDecimal(perHour(kills, total), 1) : "--";
      summaryEls.lootH.textContent = filtered.length ? formatGold(perHour(total.metrics.loot, total)) : "--";
      summaryEls.suppliesH.textContent = filtered.length ? formatGold(perHour(total.metrics.supplies, total)) : "--";
      summaryEls.damageH.textContent = filtered.length ? formatInteger(perHour(total.metrics.damage, total)) : "--";

      const rawText = rawXpTotal ? `Raw XP/h: ${formatInteger(perHour(rawXpTotal, total))}.` : "Raw XP não informado.";
      summaryEls.xpExplain.textContent = filtered.length
        ? `${formatInteger(xpTotal)} XP em ${formatDuration(total.minutes)}. ${rawText}`
        : "Média ponderada pelo tempo.";
    }

    function renderSummaryTable(filtered) {
      const aggregates = aggregateSessions(filtered, false);
      summaryBody.innerHTML = "";

      aggregates.forEach(aggregate => {
        const kills = totalKills(aggregate);
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${aggregate.hunt}</td>
          <td>${formatInteger(aggregate.sessions)}</td>
          <td>${formatDuration(aggregate.minutes)}</td>
          <td>${formatInteger(perHour(aggregate.metrics.xpGain, aggregate))}</td>
          <td>${aggregate.metrics.rawXpGain ? formatInteger(perHour(aggregate.metrics.rawXpGain, aggregate)) : "—"}</td>
          <td class="${aggregate.metrics.balance >= 0 ? "ok" : "bad"}">${formatGold(perHour(aggregate.metrics.balance, aggregate))}</td>
          <td>${formatGold(perHour(aggregate.metrics.loot, aggregate))}</td>
          <td class="warn">${formatGold(perHour(aggregate.metrics.supplies, aggregate))}</td>
          <td>${formatDecimal(perHour(kills, aggregate), 1)}</td>
        `;
        summaryBody.appendChild(tr);
      });
    }

    function renderMonsterTable(filtered) {
      const rows = [];
      aggregateSessions(filtered, false).forEach(aggregate => {
        const kills = totalKills(aggregate);
        Object.keys(aggregate.monsters).forEach(monster => {
          const count = aggregate.monsters[monster];
          rows.push({
            hunt: aggregate.hunt,
            monster,
            count,
            perHour: perHour(count, aggregate),
            share: kills ? count / kills : 0
          });
        });
      });

      rows.sort((a, b) => b.perHour - a.perHour || a.monster.localeCompare(b.monster));
      monsterBody.innerHTML = "";

      rows.forEach(row => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${row.hunt}</td>
          <td class="lbl">${titleName(row.monster)}</td>
          <td>${formatInteger(row.count)}</td>
          <td>${formatDecimal(row.perHour, 1)}</td>
          <td>${formatDecimal(row.share * 100, 1)}%</td>
        `;
        monsterBody.appendChild(tr);
      });
    }

    function renderItemTable(filtered) {
      const rows = [];
      aggregateSessions(filtered, false).forEach(aggregate => {
        Object.keys(aggregate.items).forEach(item => {
          const count = aggregate.items[item];
          rows.push({
            hunt: aggregate.hunt,
            item,
            count,
            perHour: perHour(count, aggregate)
          });
        });
      });

      rows.sort((a, b) => b.perHour - a.perHour || a.item.localeCompare(b.item));
      itemBody.innerHTML = "";

      rows.slice(0, 40).forEach(row => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${row.hunt}</td>
          <td class="lbl">${row.item}</td>
          <td>${formatInteger(row.count)}</td>
          <td>${formatDecimal(row.perHour, 1)}</td>
        `;
        itemBody.appendChild(tr);
      });
    }

    function renderSessionsTable(filtered) {
      const ordered = [...filtered].sort((a, b) => {
        if (a.start && b.start) return a.start.localeCompare(b.start);
        return a.hunt.localeCompare(b.hunt);
      });

      sessionBody.innerHTML = "";

      ordered.forEach(session => {
        const kills = totalKills(session);
        const xpGain = session.metrics.xpGain || 0;
        const balance = session.metrics.balance || 0;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${session.start || "—"}</td>
          <td class="lbl">${session.hunt}</td>
          <td>${formatDuration(session.minutes)}</td>
          <td>${formatInteger(perHour(xpGain, session))}</td>
          <td class="${balance >= 0 ? "ok" : "bad"}">${formatGold(perHour(balance, session))}</td>
          <td>${formatGold(session.metrics.loot || 0)}</td>
          <td class="warn">${formatGold(session.metrics.supplies || 0)}</td>
          <td>${formatInteger(kills)}</td>
        `;
        sessionBody.appendChild(tr);
      });
    }

    function render() {
      const filtered = filteredSessions(sessions, huntFilter.value || "all", "all");
      const isEmpty = filtered.length === 0;

      summaryTag.textContent = `${formatInteger(filtered.length)} log${filtered.length === 1 ? "" : "s"}`;
      setEmpty(isEmpty);
      clearTables();
      renderSummary(filtered);

      if (isEmpty) return;

      renderSummaryTable(filtered);
      renderMonsterTable(filtered);
      renderItemTable(filtered);
      renderSessionsTable(filtered);
    }

    function analyze() {
      saveState();
      const previousHunt = huntFilter.value || "all";
      sessions = parseLogs(logInput.value, {
        defaultHunt: defaultHunt.value
      });

      refreshFilters(previousHunt);
      render();

      if (!logInput.value.trim()) {
        status.className = "status";
        status.textContent = "Nenhum log analisado ainda.";
        return;
      }

      if (!sessions.length) {
        status.className = "status bad";
        status.textContent = "Não encontrei sessões válidas. Confira se o texto contém Session, XP/h e Killed Monsters.";
        return;
      }

      const totalWarnings = sessions.reduce((sum, session) => sum + session.warnings.length, 0);
      status.className = "status ok";
      status.textContent = `${formatInteger(sessions.length)} sessão${sessions.length === 1 ? "" : "ões"} importada${sessions.length === 1 ? "" : "s"}. ${totalWarnings ? `${totalWarnings} aviso${totalWarnings === 1 ? "" : "s"} nos logs.` : "Tudo pronto."}`;
    }

    restoreState();
    refreshFilters();
    analyze();

    analyzeBtn.addEventListener("click", analyze);
    clearBtn.addEventListener("click", () => {
      logInput.value = "";
      defaultHunt.value = "";
      sessions = [];
      saveState();
      refreshFilters();
      render();
      status.className = "status";
      status.textContent = "Nenhum log analisado ainda.";
    });

    [logInput, defaultHunt].forEach(el => {
      el.addEventListener("input", saveState);
    });
    huntFilter.addEventListener("change", render);
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Core;
  }

  global.TibiaHuntAnalyzerCore = Core;

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", init);
  }
})(typeof window !== "undefined" ? window : globalThis);
