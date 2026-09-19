/** Plan management page; original compact two-card design. @module pages/PlanManagementPage */
import React from 'react';
import PageShell from '../components/PageShell';
import { notifyToast } from '../components/Toast';
import PlanCard from './plan/components/PlanCard';
import usePlanData from './plan/usePlanData';
import './plan/plan.css';
/** @returns {JSX.Element} CLI-isolated subscription dashboard. */
export default function PlanManagementPage() {
  const {
    cards
  } = usePlanData(notifyToast);
  return <PageShell title="订阅管理" native className="plan-page"><div className="plan-scroll np-scroll" data-testid="plan-content-scroll-container"><div className="plan-cards" data-testid="plan-page-content">{cards.map(card => <PlanCard key={card.planId} {...card} />)}</div></div></PageShell>;
}
