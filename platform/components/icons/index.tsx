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
  RiAddLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiBarChartBoxLine,
  RiCalendarEventLine,
  RiCheckboxCircleFill,
  RiCheckDoubleLine,
  RiCheckLine,
  RiCloseLine,
  RiDashboardLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFileList3Line,
  RiGroupLine,
  RiHomeLine,
  RiInboxLine,
  RiInformationLine,
  RiKey2Line,
  RiLockLine,
  RiLogoutBoxRLine,
  RiPrinterLine,
  RiReceiptLine,
  RiSearchLine,
  RiShieldCheckLine,
  RiTimeLine,
  RiUserAddLine,
  RiUserFollowLine,
  RiUserLine,
  RiUserSmileLine,
} from "@remixicon/react";
