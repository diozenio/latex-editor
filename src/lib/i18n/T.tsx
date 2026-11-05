import { Fragment, type ReactNode } from "react";
import { type MessageKey, type Params, useT } from "./index";

export function T({
  k,
  params,
  values,
}: {
  k: MessageKey;
  params?: Params;
  values: Record<string, ReactNode>;
}) {
  const t = useT();
  const text = t(k, params);
  return (
    <>
      {text.split(/(\{\w+\})/g).map((part, i) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        return (
          <Fragment key={i}>
            {name && name in values ? values[name] : part}
          </Fragment>
        );
      })}
    </>
  );
}
