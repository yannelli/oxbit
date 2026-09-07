import { useSyncExternalStore } from "react";
import type { IconThemeKind, IconThemes, Kernel } from "@oxbit/sdk";
import { Select } from "./select.js";
const noSubscribe = () => () => {};
const noSnapshot = () => 0;
export function IconThemeSelect({ kernel, kind, value, onChange, openRequest = 0 }: { kernel: Kernel; kind: IconThemeKind; value?: string; onChange?: (value: string) => void; openRequest?: number }) {
  const service = kernel.services.optional<IconThemes>('iconThemes');
  useSyncExternalStore(service?.subscribe ?? noSubscribe, service?.snapshot ?? noSnapshot);
  const setting = kind === 'fileIconTheme' ? 'workbench.iconTheme' : 'workbench.productIconTheme';
  const selected = value ?? kernel.configuration.get<string>(setting) ?? 'oxbit.default';
  const options = [{ value: 'oxbit.default', label: 'Oxbit Default' }, ...(service?.themes(kind) ?? []).map(theme => ({ value: theme.id, label: `${theme.label} (${theme.id.split('/')[0]})` }))];
  if (!options.some(o => o.value === selected)) options.push({ value: selected, label: `${selected} (unavailable — using default)` });
  return <Select label={kind === 'fileIconTheme' ? 'File Icon Theme' : 'Product Icon Theme'} value={selected} options={options} onChange={onChange ?? (id => kernel.configuration.set(setting, id))} openRequest={openRequest} />;
}
