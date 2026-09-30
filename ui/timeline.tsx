import React from "react";
import { Box, Text } from "ink";
import { C, truncate, getTerminalWidth, stripAnsi } from "../lib";
import { localConfig } from "../lib/config";
import type { TimelineData, TimelineEvent } from "../lib";
import { getStatusColor } from "./format";

// Whether this event type opens a lane (first appearance of ticket)
function isOpenEvent(t: string): boolean {
  return t === "created" || t === "started" || t === "instant";
}

// Whether this event type closes a lane
function isCloseEvent(t: string): boolean {
  return t === "done" || t === "instant";
}

function parseKey(key: string): [string, number] {
  const dash = key.lastIndexOf("-");
  return [key.slice(0, dash), parseInt(key.slice(dash + 1))];
}

function sortGroupEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    const [projA, numA] = parseKey(a.key);
    const [projB, numB] = parseKey(b.key);
    const aFirst = projA === localConfig.timelineFirstProject;
    const bFirst = projB === localConfig.timelineFirstProject;
    if (aFirst !== bFirst) return aFirst ? -1 : 1;
    if (projA !== projB) return projA.localeCompare(projB);
    return numA - numB;
  });
}


const ticketColorPalette = [
  C.brightCyan, C.brightYellow, C.brightGreen, C.brightMagenta, C.brightBlue,
  C.cyan, C.yellow, C.green, C.magenta, C.brightRed,
];

function formatDateRange(start: string, end: string): string {
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const s = new Date(start);
  const e = new Date(end);
  const now = new Date();
  const isPresent = Math.abs(e.getTime() - now.getTime()) < 7 * 24 * 60 * 60 * 1000;
  return `${fmt(s)} → ${isPresent ? "present" : fmt(e)}`;
}

type TimelineViewProps = {
  data: TimelineData;
  expandNoDate?: boolean;
};

type RenderItem =
  | { type: "single"; event: TimelineEvent }
  | { type: "merged"; events: TimelineEvent[]; eventType: "done"; rawDate: string; date: string }
  | { type: "openGroup"; events: TimelineEvent[]; rawDate: string; date: string }
  | { type: "intermediateGroup"; events: TimelineEvent[]; rawDate: string; date: string };

export function TimelineView({ data, expandNoDate }: TimelineViewProps): JSX.Element {
  const { events, noDateTickets, dateRange, stats } = data;
  const termWidth = getTerminalWidth();

  if (events.length === 0 && noDateTickets.length === 0) {
    return (
      <Box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <Text>{`  ${C.dim}No tickets found${C.reset}`}</Text>
      </Box>
    );
  }

  const lines: string[] = [];

  // Header
  const headerParts = [`${C.bold}Timeline${C.reset}`];
  headerParts.push(`${C.dim}·${C.reset}  ${stats.total} ticket${stats.total !== 1 ? "s" : ""}`);
  if (events.length > 0) {
    headerParts.push(`${C.dim}·${C.reset}  ${formatDateRange(dateRange.start, dateRange.end)}`);
  }
  if (stats.done > 0 || stats.active > 0) {
    const parts: string[] = [];
    if (stats.done > 0) parts.push(`${stats.done} done`);
    if (stats.active > 0) parts.push(`${stats.active} active`);
    headerParts.push(`${C.dim}·${C.reset}  ${parts.join(", ")}`);
  }
  lines.push("");
  lines.push(`  ${headerParts.join("  ")}`);
  lines.push("");

  // Build per-ticket color map (order of first appearance in events)
  const ticketColorMap = new Map<string, string>();
  let colorIdx = 0;
  for (const event of events) {
    if (!ticketColorMap.has(event.key)) {
      ticketColorMap.set(event.key, ticketColorPalette[colorIdx % ticketColorPalette.length]);
      colorIdx++;
    }
  }
  for (const issue of noDateTickets) {
    if (!ticketColorMap.has(issue.key)) {
      ticketColorMap.set(issue.key, ticketColorPalette[colorIdx % ticketColorPalette.length]);
      colorIdx++;
    }
  }

  // Find max lane for width calculation
  const maxLane = events.reduce((max, e) => Math.max(max, e.lane), 0);
  const laneCount = maxLane + 1;

  // Build render items
  const renderItems: RenderItem[] = [];
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (event.eventType === "created") {
      // Group same-date created events
      const group = [event];
      let j = i + 1;
      while (j < events.length && events[j].rawDate === event.rawDate && events[j].eventType === "created") {
        group.push(events[j]);
        j++;
      }
      if (group.length > 1) {
        renderItems.push({ type: "openGroup", events: group, rawDate: event.rawDate, date: event.date });
      } else {
        renderItems.push({ type: "single", event });
      }
      i = j;
    } else if (isCloseEvent(event.eventType)) {
      // Group same-date same-type closers
      const group = [event];
      let j = i + 1;
      while (
        j < events.length &&
        events[j].rawDate === event.rawDate &&
        events[j].eventType === event.eventType
      ) {
        group.push(events[j]);
        j++;
      }
      if (group.length > 1) {
        renderItems.push({
          type: "merged",
          events: group,
          eventType: "done",
          rawDate: event.rawDate,
          date: event.date,
        });
      } else {
        renderItems.push({ type: "single", event });
      }
      i = j;
    } else {
      // Group same-date same-type intermediate events (started, testing, completed)
      const group = [event];
      let j = i + 1;
      while (j < events.length && events[j].rawDate === event.rawDate && events[j].eventType === event.eventType) {
        group.push(events[j]);
        j++;
      }
      if (group.length > 1) {
        renderItems.push({ type: "intermediateGroup", events: group, rawDate: event.rawDate, date: event.date });
      } else {
        renderItems.push({ type: "single", event });
      }
      i = j;
    }
  }

  function eventIcon(eventType: string, ticketColor: string): string {
    switch (eventType) {
      case "created":   return `${ticketColor}\uF055${C.reset}`;
      case "started":   return `${ticketColor}\uF04B${C.reset}`;
      case "testing":   return `${ticketColor}\uF0C3${C.reset}`;
      case "completed": return `${ticketColor}\uF00C${C.reset}`;
      case "done":      return `${ticketColor}\uF058${C.reset}`;
      case "instant":   return `${ticketColor}\uF058${C.reset}`;
      default:          return `${ticketColor}\uF111${C.reset}`;
    }
  }

  // Track active lanes and which ticket occupies each lane (for colored connectors)
  const activeLanes = new Set<number>();
  const laneTicket = new Map<number, string>();

  function coloredBar(l: number): string {
    const occupant = laneTicket.get(l);
    const lc = occupant ? ticketColorMap.get(occupant) || C.white : C.white;
    return `${C.dim}${lc}│${C.reset}`;
  }

  const seenTickets = new Set<string>();

  // Layout: "  date  [lanes]  key  title"
  // datePart visible width is always 9: 2 indent + 5 date + 2 gap
  const DATE_PART_W = 9;
  const blankDate = "         ";

  function buildLanePart(laneChars: string[]): string {
    return laneChars.join(" ") + "  ";
  }

  for (const item of renderItems) {
    if (item.type === "openGroup") {
      const sorted = sortGroupEvents(item.events);
      const groupLanes = new Set(sorted.map(ev => ev.lane));
      for (const ev of sorted) {
        activeLanes.add(ev.lane);
        laneTicket.set(ev.lane, ev.key);
      }

      for (let ei = 0; ei < sorted.length; ei++) {
        const ev = sorted[ei];
        const tc = ticketColorMap.get(ev.key) || C.white;
        const laneChars: string[] = [];
        for (let l = 0; l < laneCount; l++) {
          if (ei === 0 && groupLanes.has(l)) {
            const oc = ticketColorMap.get(laneTicket.get(l)!) || C.white;
            laneChars.push(eventIcon(ev.eventType, oc));
          } else if (activeLanes.has(l)) {
            laneChars.push(coloredBar(l));
          } else {
            laneChars.push(" ");
          }
        }
        const lanePart = buildLanePart(laneChars);
        const datePart = ei === 0 ? `  ${C.dim}${ev.date.padEnd(5)}${C.reset}  ` : blankDate;
        const indent = ei > 0 ? " " : "";
        const coloredKey = `${tc}${ev.key}${C.reset}`;
        const isFirst = !seenTickets.has(ev.key);
        seenTickets.add(ev.key);
        const titleColor = isFirst ? C.white : C.dim;
        const preWidth = DATE_PART_W + stripAnsi(lanePart).length + indent.length + stripAnsi(coloredKey).length + 2;
        const summaryWidth = Math.max(10, termWidth - preWidth);
        const summaryStr = truncate(ev.summary, summaryWidth);
        lines.push(`${datePart}${lanePart}${indent}${coloredKey}  ${titleColor}${summaryStr}${C.reset}`);
      }
    } else if (item.type === "merged") {
      const sorted = sortGroupEvents(item.events);
      const groupLanes = new Set(sorted.map(ev => ev.lane));

      for (let ei = 0; ei < sorted.length; ei++) {
        const ev = sorted[ei];
        const tc = ticketColorMap.get(ev.key) || C.white;
        const laneChars: string[] = [];
        for (let l = 0; l < laneCount; l++) {
          if (ei === 0 && groupLanes.has(l)) {
            const oc = ticketColorMap.get(laneTicket.get(l)!) || C.white;
            laneChars.push(eventIcon(ev.eventType, oc));
          } else if (activeLanes.has(l)) {
            laneChars.push(coloredBar(l));
          } else {
            laneChars.push(" ");
          }
        }
        const lanePart = buildLanePart(laneChars);
        const datePart = ei === 0 ? `  ${C.dim}${item.date.padEnd(5)}${C.reset}  ` : blankDate;
        const indent = ei > 0 ? " " : "";
        const coloredKey = `${C.dim}${tc}${ev.key}${C.reset}`;
        const durationStr = ev.duration ? `  ${C.dim}${ev.duration}${C.reset}` : "";
        const isFirst = !seenTickets.has(ev.key);
        seenTickets.add(ev.key);
        const titleColor = isFirst ? C.white : C.dim;
        const preWidth = DATE_PART_W + stripAnsi(lanePart).length + indent.length + stripAnsi(coloredKey).length + stripAnsi(durationStr).length + 2;
        const summaryWidth = Math.max(10, termWidth - preWidth);
        const summaryStr = truncate(ev.summary, summaryWidth);
        lines.push(`${datePart}${lanePart}${indent}${coloredKey}${durationStr}  ${titleColor}${summaryStr}${C.reset}`);

        if (ei === 0) {
          for (const gev of sorted) {
            activeLanes.delete(gev.lane);
            laneTicket.delete(gev.lane);
          }
        }
      }
    } else if (item.type === "intermediateGroup") {
      const sorted = sortGroupEvents(item.events);
      const groupLanes = new Set(sorted.map(ev => ev.lane));
      for (let ei = 0; ei < sorted.length; ei++) {
        const ev = sorted[ei];
        const tc = ticketColorMap.get(ev.key) || C.white;
        const laneChars: string[] = [];
        for (let l = 0; l < laneCount; l++) {
          if (ei === 0 && groupLanes.has(l)) {
            const oc = ticketColorMap.get(laneTicket.get(l)!) || C.white;
            laneChars.push(eventIcon(ev.eventType, oc));
          } else if (activeLanes.has(l)) {
            laneChars.push(coloredBar(l));
          } else {
            laneChars.push(" ");
          }
        }
        const lanePart = buildLanePart(laneChars);
        const datePart = ei === 0 ? `  ${C.dim}${ev.date.padEnd(5)}${C.reset}  ` : blankDate;
        const indent = ei > 0 ? " " : "";
        const coloredKey = `${tc}${ev.key}${C.reset}`;
        const isFirst = !seenTickets.has(ev.key);
        seenTickets.add(ev.key);
        const titleColor = isFirst ? C.white : C.dim;
        const preWidth = DATE_PART_W + stripAnsi(lanePart).length + indent.length + stripAnsi(coloredKey).length + 2;
        const summaryWidth = Math.max(10, termWidth - preWidth);
        const summaryStr = truncate(ev.summary, summaryWidth);
        lines.push(`${datePart}${lanePart}${indent}${coloredKey}  ${titleColor}${summaryStr}${C.reset}`);
      }
    } else {
      const event = item.event;
      const ticketColor = ticketColorMap.get(event.key) || C.white;

      if (isOpenEvent(event.eventType)) {
        activeLanes.add(event.lane);
        laneTicket.set(event.lane, event.key);
      }

      const laneChars: string[] = [];
      for (let l = 0; l < laneCount; l++) {
        if (l === event.lane) {
          laneChars.push(eventIcon(event.eventType, ticketColor));
        } else if (activeLanes.has(l)) {
          laneChars.push(coloredBar(l));
        } else {
          laneChars.push(" ");
        }
      }
      const lanePart = buildLanePart(laneChars);
      const datePart = `  ${C.dim}${event.date.padEnd(5)}${C.reset}  `;
      const isFirst = !seenTickets.has(event.key);
      seenTickets.add(event.key);
      const titleColor = isFirst ? C.white : C.dim;

      if (isCloseEvent(event.eventType)) {
        const coloredKey = `${C.dim}${ticketColor}${event.key}${C.reset}`;
        const durationStr = event.duration ? `  ${C.dim}${event.duration}${C.reset}` : "";
        const preWidth = DATE_PART_W + stripAnsi(lanePart).length + stripAnsi(coloredKey).length + stripAnsi(durationStr).length + 2;
        const summaryWidth = Math.max(10, termWidth - preWidth);
        const summaryStr = truncate(event.summary, summaryWidth);
        lines.push(`${datePart}${lanePart}${coloredKey}${durationStr}  ${titleColor}${summaryStr}${C.reset}`);
        activeLanes.delete(event.lane);
        laneTicket.delete(event.lane);
      } else {
        const coloredKey = `${ticketColor}${event.key}${C.reset}`;
        const preWidth = DATE_PART_W + stripAnsi(lanePart).length + stripAnsi(coloredKey).length + 2;
        const summaryWidth = Math.max(10, termWidth - preWidth);
        const summaryStr = truncate(event.summary, summaryWidth);
        lines.push(`${datePart}${lanePart}${coloredKey}  ${titleColor}${summaryStr}${C.reset}`);
      }
    }
  }

  // No-date section
  if (noDateTickets.length > 0) {
    const MAX_NO_DATE = 5;
    const showAll = expandNoDate || noDateTickets.length <= MAX_NO_DATE;
    const visible = showAll ? noDateTickets : noDateTickets.slice(0, MAX_NO_DATE);
    const hidden = noDateTickets.length - visible.length;

    lines.push("");
    lines.push(`  ${C.dim}── No timeline data (${noDateTickets.length}) ──${C.reset}`);
    for (const issue of visible) {
      const sc = getStatusColor(issue.status);
      const tc = ticketColorMap.get(issue.key) || C.white;
      const ck = `${tc}${issue.key}${C.reset}`;
      const leftPart = `    ${ck}   ${C.dim}${truncate(issue.summary, 30)}${C.reset}`;
      const rightPart = `${sc}${issue.status}${C.reset}`;
      const lw = stripAnsi(leftPart).length;
      const rw = stripAnsi(rightPart).length;
      const pad = Math.max(2, termWidth - lw - rw);
      lines.push(`${leftPart}${" ".repeat(pad)}${rightPart}`);
    }
    if (hidden > 0) {
      lines.push(`    ${C.dim}.. ${hidden} more [-e to show all]${C.reset}`);
    }
  }

  lines.push("");

  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
    </Box>
  );
}
