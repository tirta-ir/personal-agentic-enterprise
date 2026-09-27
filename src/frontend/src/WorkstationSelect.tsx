import { Label } from "@/components/ui/label";
import type { Workstation } from "./bindings/Workstation";

export function WorkstationSelect({ id, value, workstations, disabled, onChange }: {
  id: string; value: string; workstations: Workstation[]; disabled?: boolean; onChange: (id: string) => void;
}) {
  return <>
    <Label htmlFor={id}>Workstation</Label>
    <select id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">Local · This machine</option>
      <optgroup label="Remote · Saved SSH settings">
        {workstations.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}
        {value && !workstations.some(host => host.id === value) && <option value={value}>{value} · Existing SSH alias</option>}
      </optgroup>
    </select>
    <p className="hint"><a href="/settings/workstations">Manage workstations in user settings</a></p>
  </>;
}
