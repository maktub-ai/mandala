import BrandMark from "./ui/BrandMark";
import { identityCells, identityColor, type IdentityAppearance, type IdentityKind } from "../shared/identity";
import "./identity.css";
import { IdentityGlyph } from "./identity-icons";

// Agents always sit in a tinted circle (who); Projects are a bare glyph or emoji (where).
// The container, not the chosen symbol, tells the two apart; files use rounded tiles.
export default function IdentityAvatar({ identity, kind, size = 28 }: {
  identity: IdentityAppearance & { name: string; systemRole?: "mandala" };
  kind: IdentityKind;
  size?: number;
}) {
  if (kind === "agent" && identity.systemRole === "mandala") return <span style={{width:size,height:size,display:"inline-flex",flexShrink:0}}><BrandMark className="mandala-avatar"/></span>;
  const color = identityColor(identity, kind), emoji = identity.emoji;
  if (kind === "project") {
    if (emoji) return <span className="project-marker identity-emoji" data-project-marker="true" data-identity-kind="project" data-identity-emoji={emoji} aria-hidden="true"
      style={{width:size,height:size,fontSize:Math.round(size*0.84)}}>{emoji}</span>;
    return <IdentityGlyph name={identity.icon ?? "project"} className="project-marker" size={size} color={color}
      data-project-marker="true" data-identity-kind="project" data-project-icon={identity.icon ?? "project"} />;
  }
  const inner = emoji ? <span className="identity-emoji" data-identity-emoji={emoji} style={{fontSize:Math.round(size*0.56)}}>{emoji}</span>
    : identity.icon ? <IdentityGlyph name={identity.icon} size={Math.round(size*0.56)} color={color} data-agent-icon={identity.icon}/>
    : <svg width={Math.round(size*0.6)} height={Math.round(size*0.6)} viewBox="0 0 30 30" aria-hidden="true" focusable="false">
        <g fill={color}>{identityCells(kind + ":" + (identity.avatarSeed ?? identity.id)).map(({ x, y }) => <rect key={`${x}-${y}`} x={x * 6} y={y * 6} width="6" height="6" />)}</g>
      </svg>;
  return <span className="identity-avatar" data-identity-kind={kind} aria-hidden="true"
    style={{width:size,height:size,background:`color-mix(in srgb, ${color} 14%, var(--avatar-base, transparent))`}}>{inner}</span>;
}
