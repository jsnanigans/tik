import React, { useEffect } from "react";
import { render, useApp } from "ink";

type StaticProps = {
  children: React.ReactNode;
};

function StaticApp({ children }: StaticProps): JSX.Element {
  const { exit } = useApp();

  useEffect(() => {
    exit();
  }, [exit]);

  return <>{children}</>;
}

export async function renderStatic(element: React.ReactElement): Promise<void> {
  const instance = render(<StaticApp>{element}</StaticApp>);
  await instance.waitUntilExit();
}

export function renderInteractive(element: React.ReactElement) {
  const instance = render(element);
  return {
    rerender: (next: React.ReactElement) => instance.rerender(next),
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
