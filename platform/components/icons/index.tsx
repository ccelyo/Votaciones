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
  RiAddCircleLine,
  RiBarChartBoxLine,
  RiDashboardLine,
  RiDeleteBinLine,
  RiHomeLine,
  RiImageAddLine,
  RiArrowDownSLine,
  type RemixiconComponentType,
} from "@remixicon/react";