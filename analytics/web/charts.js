// Gráficas SVG del panel de analytics, sin dependencias externas.
// Todo el texto entra por textContent: los nombres de las opciones vienen de
// eventos y nunca se interpretan como HTML.
"use strict";

(function () {
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  // --- Tooltip compartido ------------------------------------------------------
  let tooltip;
  function ensureTooltip() {
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "tooltip";
      tooltip.hidden = true;
      tooltip.setAttribute("role", "status");
      document.body.append(tooltip);
    }
    return tooltip;
  }

  function attachTooltips(container) {
    container.addEventListener("pointermove", (event) => {
      const target = event.target.closest?.("[data-tip]");
      const tip = ensureTooltip();
      if (!target || !container.contains(target)) {
        tip.hidden = true;
        return;
      }
      tip.textContent = target.getAttribute("data-tip");
      tip.hidden = false;
      const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = Math.max(8, event.clientY - tip.offsetHeight - 12);
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
    container.addEventListener("pointerleave", () => {
      if (tooltip) tooltip.hidden = true;
    });
  }

  function mount(container, svg, label) {
    container.replaceChildren();
    container.classList.add("chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    container.append(svg);
    if (!container.dataset.tooltips) {
      attachTooltips(container);
      container.dataset.tooltips = "1";
    }
  }

  // Cada gráfica se dibuja al ancho real de su contenedor (el texto conserva su
  // tamaño) y se vuelve a dibujar cuando cambia el tamaño de la ventana.
  function widthOf(container, fallback) {
    return Math.max(280, Math.round(container.clientWidth || fallback));
  }

  function remember(container, draw) {
    container.__redraw = draw;
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll(".chart").forEach((node) => {
        if (node.__redraw && node.isConnected) node.__redraw();
      });
    }, 150);
  });

  function niceMax(value) {
    if (value <= 0) return 1;
    const exponent = Math.pow(10, Math.floor(Math.log10(value)));
    const fraction = value / exponent;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * exponent;
  }

  // --- Barras horizontales ----------------------------------------------------
  // items: [{ label, value, valueText, color, tip, note }]
  function barsH(container, items, opts = {}) {
    const { label = "Gráfica de barras", max } = opts;
    remember(container, () => barsH(container, items, opts));
    const width = widthOf(container, 640);
    const rowHeight = 50;
    const height = Math.max(rowHeight, items.length * rowHeight);
    const top = max ?? Math.max(1, ...items.map((i) => i.value));
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "xMidYMid meet" });

    items.forEach((item, index) => {
      const y = index * rowHeight;
      const barWidth = Math.max(item.value > 0 ? 3 : 0, (item.value / top) * width);
      const group = el("g", { "data-tip": item.tip ?? `${item.label}: ${item.valueText ?? item.value}` });
      group.append(
        el("text", { x: 0, y: y + 15, class: "value-label" }, [item.label]),
        el("text", { x: width, y: y + 15, "text-anchor": "end", class: "value-label" }, [item.valueText ?? String(item.value)]),
        el("rect", { x: 0, y: y + 23, width, height: 14, rx: 3, fill: "#eef2f8" }),
        el("rect", { x: 0, y: y + 23, width: barWidth, height: 14, rx: 3, fill: item.color ?? "#0b3ea8" }),
        el("rect", { x: 0, y, width, height: rowHeight, fill: "transparent" }),
      );
      if (item.note) {
        const labelWidth = Math.min(width * 0.6, item.label.length * 7.2 + 12);
        group.append(el("text", { x: labelWidth, y: y + 15, class: "axis-label" }, [item.note]));
      }
      svg.append(group);
    });
    mount(container, svg, label);
  }

  // --- Dona ---------------------------------------------------------------------
  // segments: [{ label, value, color, tip }]
  function donut(container, segments, { centerValue = "", centerLabel = "", label = "Gráfica de dona" } = {}) {
    const size = 200;
    const radius = 78;
    const stroke = 30;
    const circumference = 2 * Math.PI * radius;
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    const svg = el("svg", { viewBox: `0 0 ${size} ${size}` });
    svg.append(el("circle", { cx: 100, cy: 100, r: radius, fill: "none", stroke: "#eef2f8", "stroke-width": stroke }));

    let offset = 0;
    const visible = segments.filter((s) => s.value > 0);
    visible.forEach((segment) => {
      const length = total > 0 ? (segment.value / total) * circumference : 0;
      const gap = visible.length > 1 ? Math.min(2, length / 3) : 0;
      svg.append(
        el("circle", {
          cx: 100,
          cy: 100,
          r: radius,
          fill: "none",
          stroke: segment.color,
          "stroke-width": stroke,
          "stroke-dasharray": `${Math.max(0, length - gap)} ${circumference}`,
          "stroke-dashoffset": -offset,
          transform: "rotate(-90 100 100)",
          "data-tip": segment.tip ?? `${segment.label}: ${segment.value}`,
        }),
      );
      offset += length;
    });
    svg.append(
      el("text", { x: 100, y: 99, "text-anchor": "middle", "font-size": 26, "font-weight": 700, fill: "#0b1730" }, [centerValue]),
      el("text", { x: 100, y: 120, "text-anchor": "middle", "font-size": 11, fill: "#6b7891" }, [centerLabel]),
    );
    mount(container, svg, label);
  }

  // --- Columnas con línea acumulada --------------------------------------------
  // points: [{ label, value, tip, line }] — line ∈ [0, lineMax]
  function columns(container, points, opts = {}) {
    remember(container, () => columns(container, points, opts));
    const {
      label = "Gráfica de columnas",
      color = "#0b3ea8",
      lineColor = "#0c1f47",
      lineMax = 1,
      lineFormat = (v) => String(v),
      valueFormat = (v) => String(v),
      showLine = false,
      highlight = -1,
    } = opts;
    const width = widthOf(container, 720);
    const height = 280;
    const pad = { top: 16, right: showLine ? 52 : 12, bottom: 34, left: 44 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}` });

    for (let i = 0; i <= 4; i++) {
      const y = pad.top + innerH - (innerH * i) / 4;
      svg.append(
        el("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: "grid-line" }),
        el("text", { x: pad.left - 8, y: y + 4, "text-anchor": "end", class: "axis-label" }, [valueFormat((max * i) / 4)]),
      );
      if (showLine) {
        svg.append(
          el("text", { x: width - pad.right + 8, y: y + 4, class: "axis-label" }, [lineFormat((lineMax * i) / 4)]),
        );
      }
    }

    const slot = innerW / Math.max(1, points.length);
    const barWidth = Math.max(2, Math.min(42, slot * 0.68));
    const labelEvery = Math.ceil(points.length / Math.max(1, Math.floor(innerW / 54)));
    const linePoints = [];

    points.forEach((point, index) => {
      const cx = pad.left + slot * index + slot / 2;
      const barHeight = (point.value / max) * innerH;
      const group = el("g", { "data-tip": point.tip ?? `${point.label}: ${valueFormat(point.value)}` });
      group.append(
        el("rect", { x: cx - slot / 2, y: pad.top, width: slot, height: innerH, fill: "transparent" }),
        el("rect", {
          x: cx - barWidth / 2,
          y: pad.top + innerH - barHeight,
          width: barWidth,
          height: Math.max(point.value > 0 ? 1.5 : 0, barHeight),
          rx: 2,
          fill: index === highlight ? "#2470e3" : color,
        }),
      );
      svg.append(group);
      if (index % labelEvery === 0) {
        svg.append(el("text", { x: cx, y: height - pad.bottom + 18, "text-anchor": "middle", class: "axis-label" }, [point.label]));
      }
      if (showLine && point.line !== null && point.line !== undefined) {
        linePoints.push([cx, pad.top + innerH - (Math.min(point.line, lineMax) / lineMax) * innerH]);
      }
    });

    if (linePoints.length > 0) {
      const d = linePoints.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      svg.append(el("path", { d, fill: "none", stroke: lineColor, "stroke-width": 2.5, "stroke-linejoin": "round", "pointer-events": "none" }));
      for (const [x, y] of linePoints) {
        svg.append(el("circle", { cx: x, cy: y, r: 3.5, fill: "#fff", stroke: lineColor, "stroke-width": 2, "pointer-events": "none" }));
      }
    }
    svg.append(el("line", { x1: pad.left, x2: width - pad.right, y1: pad.top + innerH, y2: pad.top + innerH, stroke: "#a9b4c8" }));
    mount(container, svg, label);
  }

  // --- Mini serie (tarjetas de elecciones en curso) -----------------------------
  function sparkline(container, values, opts = {}) {
    const { label = "Tendencia", color = "#0b3ea8" } = opts;
    const width = 240;
    const height = 44;
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
    if (values.length > 0) {
      const max = Math.max(1, ...values);
      const step = values.length > 1 ? width / (values.length - 1) : width;
      const pts = values.map((v, i) => [values.length > 1 ? i * step : width / 2, height - 4 - (v / max) * (height - 8)]);
      const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      svg.append(
        el("path", { d: `${line} L${pts[pts.length - 1][0]},${height} L${pts[0][0]},${height} Z`, fill: "#dfe9fb" }),
        el("path", { d: line, fill: "none", stroke: color, "stroke-width": 2 }),
      );
    }
    mount(container, svg, label);
  }

  window.Charts = { barsH, donut, columns, sparkline };
})();
