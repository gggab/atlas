import atlasIconUrl from "@/assets/atlas-icon.svg";
import { cn } from "@/lib/utils";
import { DEFAULT_APP_PROFILE } from "@/lib/app-profile";

interface AtlasIconProps {
  size?: number;
  className?: string;
  alt?: string;
}

export function AtlasIcon({
  size = 32,
  className,
  alt = DEFAULT_APP_PROFILE.productName,
}: AtlasIconProps) {
  return (
    <img
      src={atlasIconUrl}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      className={cn("select-none", className)}
      style={{ width: size, height: size }}
    />
  );
}
