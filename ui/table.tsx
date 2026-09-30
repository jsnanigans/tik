import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { stripAnsi } from "../lib";

type Align = "left" | "right";

export type TableColumn<Row> = {
  key: string;
  header?: string;
  width?: number;
  align?: Align;
  render: (row: Row, rowIndex: number) => string;
};

export type TableProps<Row> = {
  columns: TableColumn<Row>[];
  rows: Row[];
  showHeader?: boolean;
  selectable?: boolean;
  selectedIndex?: number;
  highlightIndex?: number;
  onSelect?: (row: Row, rowIndex: number) => void;
  onHighlight?: (row: Row, rowIndex: number) => void;
  rowKey?: (row: Row, rowIndex: number) => string;
  pointer?: string;
};

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function pad(value: string, width: number, align: Align): string {
  const len = visibleLength(value);
  if (len >= width) return value;
  const padSize = width - len;
  return align === "right" ? " ".repeat(padSize) + value : value + " ".repeat(padSize);
}

export function Table<Row>({
  columns,
  rows,
  showHeader = true,
  selectable = false,
  selectedIndex,
  highlightIndex,
  onSelect,
  onHighlight,
  rowKey,
  pointer = "›",
}: TableProps<Row>): JSX.Element {
  const [activeIndex, setActiveIndex] = useState(selectedIndex ?? 0);

  useEffect(() => {
    if (typeof selectedIndex === "number") {
      setActiveIndex(selectedIndex);
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (!selectable) return;
    if (rows.length === 0) return;
    if (!onHighlight) return;
    const idx = Math.min(activeIndex, rows.length - 1);
    onHighlight(rows[idx], idx);
  }, [activeIndex, onHighlight, rows, selectable]);

  useInput((_input, key) => {
    if (!selectable) return;
    if (rows.length === 0) return;
    if (key.upArrow) {
      setActiveIndex(index => Math.max(0, index - 1));
    } else if (key.downArrow) {
      setActiveIndex(index => Math.min(rows.length - 1, index + 1));
    } else if (key.return) {
      const idx = Math.min(activeIndex, rows.length - 1);
      onSelect?.(rows[idx], idx);
    }
  });

  const displayIndex = selectable ? activeIndex : highlightIndex;
  const showPointer = selectable || typeof highlightIndex === "number";

  const widths = useMemo(() => {
    return columns.map(col => {
      if (col.width) return col.width;
      let maxLen = col.header ? visibleLength(col.header) : 0;
      for (let i = 0; i < rows.length; i++) {
        const cell = col.render(rows[i], i);
        maxLen = Math.max(maxLen, visibleLength(cell));
      }
      return maxLen;
    });
  }, [columns, rows]);

  return (
    <Box flexDirection="column">
      {showHeader && (
        <Box>
          {showPointer && <Text>{" ".repeat(pointer.length + 1)}</Text>}
          {columns.map((col, idx) => {
            const value = col.header ?? "";
            const cell = pad(value, widths[idx], col.align ?? "left");
            return (
              <Text key={col.key} bold>
                {cell}
                {idx === columns.length - 1 ? "" : " "}
              </Text>
            );
          })}
        </Box>
      )}
      {rows.map((row, rowIndex) => {
        const isActive = showPointer && rowIndex === displayIndex;
        const key = rowKey ? rowKey(row, rowIndex) : String(rowIndex);
        return (
          <Box key={key}>
            {showPointer && (
              <Text color={isActive ? "cyan" : "gray"}>
                {isActive ? pointer : " ".repeat(pointer.length)}
                {" "}
              </Text>
            )}
            {columns.map((col, colIndex) => {
              const value = col.render(row, rowIndex);
              const cell = pad(value, widths[colIndex], col.align ?? "left");
              return (
                <Text key={col.key} inverse={isActive}>
                  {cell}
                  {colIndex === columns.length - 1 ? "" : " "}
                </Text>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
