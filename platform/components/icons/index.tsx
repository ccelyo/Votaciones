import type { RemixiconComponentType } from "@remixicon/react";

type IconProps = {
  icon: RemixiconComponentType;
  size?: number | string;
  className?: string;
};

export function Icon({ icon: Component, size = 20, className }: IconProps) {
  return <Component size={size} className={className} aria-hidden />;
}

export {
  type RemixiconComponentType,
  RiAddCircleLine,
  RiBarChartBoxLine,
  RiCloseLine,
  RiDashboardLine,
  RiDeleteBinLine,
  RiHomeLine,
  RiImageAddLine,
  RiLogoutBoxLine,
  RiMenuLine,
} from "@remixicon/react";
