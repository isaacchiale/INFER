import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { searchableEntities, validationIssues } from "@/data/mock";

const pages = [
  { id: "workspace", label: "Workspace", path: "/" as const },
  { id: "overview", label: "Overview", path: "/overview" as const },
  { id: "validation", label: "Validation", path: "/validation" as const },
  { id: "assets", label: "Assets", path: "/assets" as const },
];

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search spaces, doors, validation issues or modules…" />
      <CommandList>
        <CommandEmpty>No matching entity in the compiled spatial model.</CommandEmpty>
        <CommandGroup heading="Pages">
          {pages.map((m) => (
            <CommandItem
              key={m.id}
              value={`page ${m.label}`}
              onSelect={() => {
                onOpenChange(false);
                navigate({ to: m.path });
              }}
            >
              {m.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Model entities">
          {searchableEntities.map((e) => (
            <CommandItem key={e.id} value={`${e.label} ${e.kind}`} onSelect={() => onOpenChange(false)}>
              <span>{e.label}</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">{e.kind}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Validation issues">
          {validationIssues.slice(0, 6).map((i) => (
            <CommandItem
              key={i.id}
              value={i.title}
              onSelect={() => {
                onOpenChange(false);
                navigate({ to: "/validation" });
              }}
            >
              <span className="truncate">{i.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
