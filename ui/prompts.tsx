import React, { useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Table, type TableColumn } from "./table";
import { renderInteractive } from "./render";

type SelectOption<T> = {
  value: T;
  label: string;
  description?: string;
};

export async function promptSelect<T>(
  title: string,
  options: SelectOption<T>[]
): Promise<T | null> {
  return new Promise(resolve => {
    let settled = false;
    const App = () => {
      const { exit } = useApp();
      const [selected, setSelected] = useState(0);

      const columns: TableColumn<SelectOption<T>>[] = useMemo(() => [
        { key: "label", render: row => row.label },
        { key: "description", render: row => row.description ?? "" },
      ], []);

      return (
        <Box flexDirection="column">
          <Text>{title}</Text>
          <Table
            columns={columns}
            rows={options}
            selectable
            selectedIndex={selected}
            onHighlight={(_row, idx) => setSelected(idx)}
            onSelect={(row) => {
              if (!settled) {
                settled = true;
                resolve(row.value);
              }
              exit();
            }}
          />
          <Text>Press Enter to select</Text>
        </Box>
      );
    };

    const { waitUntilExit } = renderInteractive(<App />);
    void waitUntilExit().then(() => {
      if (!settled) resolve(null);
    });
  });
}
