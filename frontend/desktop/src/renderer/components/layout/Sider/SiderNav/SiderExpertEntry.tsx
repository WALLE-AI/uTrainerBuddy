import React from 'react';
import { Tooltip } from '@arco-design/web-react';
import { Peoples } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

type Props = {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
};

export default function SiderExpertEntry({ isMobile, isActive, collapsed, siderTooltipProps, onClick }: Props) {
  const { t } = useTranslation();
  const label = t('guid.experts.title', { defaultValue: 'Experts' });
  return <Tooltip {...siderTooltipProps} content={label} position='right'>
    <button
      type='button'
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      className={classNames(
        'box-border h-34px w-full flex items-center gap-8px border-none cursor-pointer shrink-0 transition-colors text-t-primary',
        collapsed ? 'justify-center rd-8px' : 'justify-start ps-10px pe-8px rd-0.5rem',
        isMobile && !collapsed && 'sider-action-btn-mobile',
        isActive ? 'bg-fill-3' : 'bg-transparent hover:bg-fill-3 active:bg-fill-4'
      )}
      onClick={onClick}
    >
      <span className='size-22px flex items-center justify-center shrink-0' aria-hidden='true'>
        <Peoples theme='outline' size={collapsed ? '20' : '16'} fill='currentColor' className='block leading-none' />
      </span>
      {!collapsed && <span className='text-14px font-[500] leading-24px'>{label}</span>}
    </button>
  </Tooltip>;
}
