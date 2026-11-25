import { useState } from "react";
import { isIdentityEmoji } from "../shared/identity";
import { marketSkillImage, type MarketItem } from "../shared/market";
import Icon, { type IconName } from "./ui/Icon";

function capabilityIcon(item: MarketItem): IconName {
  if (item.kind === "skill") return "book";
  return item.kind === "theme" ? "grid" : item.kind === "language" ? "globe" : item.kind === "pet" ? "sparkles"
    : /design|canvas|art|brand/.test(item.name) ? "grid" : /github|mcp-builder/.test(item.name) ? "code"
    : /pdf|doc|ppt|xls/.test(item.name) ? "file" : item.kind === "mcp" ? "tool" : "book";
}

export default function MarketCapabilityIcon({ item, size }: { item: MarketItem; size: number }) {
  const [failedImage, setFailedImage] = useState<string>();
  const icon = item.kind === "skill" ? item.skillIcon : undefined;
  return <span className={`market-capability-icon ${item.kind}`} aria-hidden="true">
    {marketSkillImage(icon) && icon !== failedImage
      ? <img src={icon} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImage(icon)} />
      : isIdentityEmoji(icon) ? <span style={{ fontSize: size }}>{icon}</span>
      : <Icon name={capabilityIcon(item)} size={size} />}
  </span>;
}
