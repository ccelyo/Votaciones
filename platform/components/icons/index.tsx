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
  RiCalendarEventLine,
  RiCheckboxCircleFill,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiHomeLine,
  RiInboxLine,
  RiKey2Line,
  RiLockLine,
  RiLogoutBoxRLine,
  RiReceiptLine,
  RiShieldCheckLine,
  RiTimeLine,
  RiUserSmileLine,
} from "@remixicon/react";
