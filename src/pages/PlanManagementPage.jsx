/** Plan management page; original compact two-card design. @module pages/PlanManagementPage */
import React, { useCallback, useState } from 'react';
import PageShell from '../components/PageShell';
import Toast from '../components/Toast';
import PlanCard from './plan/components/PlanCard';
import usePlanData from './plan/usePlanData';
import './plan/plan.css';
/** @returns {JSX.Element} CLI-isolated subscription dashboard. */
export default function PlanManagementPage() {
  const [toast, setToast] = useState(null);
  const close = useCallback(() => setToast(null), []);
  const {
    cards
  } = usePlanData(setToast);
  return <PageShell title="Plan 管理" className="page-shell--no-padding plan-page"><div className="plan-scroll" data-testid="plan-content-scroll-container"><div className="plan-cards" data-testid="plan-page-content">{cards.map(card => <PlanCard key={card.planId} {...card} />)}</div></div>{toast && <Toast key={toast.message} {...toast} onClose={close} />}</PageShell>;
}
