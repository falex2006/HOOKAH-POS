FROM node:20-alpine
ARG CRM_RELEASE_ID=unreleased
LABEL com.hookahpos.release-id=$CRM_RELEASE_ID
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY db.js server.js payroll.js recipe-depletion.js purchase-document-validation.js staff-avatar-image.js loyalty-pricing.js loyalty-memory-reconciliation.js payroll-scheme-service.js payroll-scheme-routes.js payroll-scheme-ui.js payroll-schemes.js payroll-venue-turnover-source.js order-attention.js shift-close-contract.js payroll-attendance-manifest.js payroll-canonical-pricing-source.js payroll-incentive-math.js payroll-item-return-source.js payroll-milestone-evidence.js payroll-order-pricing-evidence.js payroll-order-refund-evidence.js payroll-personal-cap-policy.js payroll-snapshot-evidence.js payroll-snapshot-reconciliation.js payroll-snapshot-source-context.js payroll-source-policies.js payroll-source-readiness.js index.html admin.html login.html inventory.html finance.html finance-categories.html finance-report.html reservations.html clients.html orders.html integrations.html network.html delivery.html platform.html admin.js style.css platform.css app.js pos-dispatch.js pos-workspace.js pos-workspace.css portal.js portal-session.js header-shell.js login.js catalog-seed.js lock.js finance-payable-offsets.js finance-payables.js finance-recurring-calculation.js finance-income.js finance-unified-report.js finance-funding.js finance-balance-events.js payroll-sale-credit-source.js ./
COPY payroll-source-fence.js ./
COPY payroll-entry-overlap-diagnostic.js payroll-calculation-input-contract.js payroll-candidate-calculation.js payroll-candidate-snapshot-bundle.js payroll-refund-review.js payroll-employment-eligibility.js payroll-employee-role-coverage.js payroll-mode-availability.js payroll-sourced-preview.js payroll-full-employee-net-revenue-source.js payroll-recognition-preview.js payroll-recognition-manifest.js payroll-product-department-source.js payroll-product-department-revisions.js payroll-team-fund-source.js ./
COPY assets ./assets
COPY inventory-order-cost-allocation.js inventory-order-cost-capture.js ./
COPY payroll-order-revenue-reconciliation.js payroll-sourced-comparison.js ./
COPY payroll-no-refund-coverage.js payroll-margin-cost-source.js pos-sale-cost-evidence.js ./
COPY payroll-personal-revenue-source.js ./
COPY notification-center.js ./
COPY finance-payable-recognition.js finance-report-venue-access.js finance-other-income.js finance-expense-drafts.js finance-expense-corrections.js finance-expense-refunds.js ui-dialog.js ./
COPY audit-privacy.js ./
COPY payroll-snapshot-persistence.js payroll-typed-snapshot-serializer.js payroll-milestone-storage-serializer.js ./
COPY payroll-verified-calculation.js payroll-verified-snapshot-input.js payroll-run-provenance.js ./
COPY payroll-saved-run-reader.js ./
COPY payroll-run-source-freshness.js ./
COPY payroll-refund-review-assessment.js payroll-refund-review-store.js ./
COPY payroll-calculation-entry-bridge.js ./
COPY payroll-calculation-entry-evidence.js payroll-reviewed-correction-policy.js payroll-reviewed-correction-command.js payroll-reviewed-correction-store.js ./
COPY payroll-refund-earnings-projection.js payroll-refund-earnings-source.js ./
COPY payroll-refund-recalculation-basis.js ./
COPY payroll-refund-counterfactual.js ./
COPY payroll-refund-economic-source.js payroll-refund-frozen-cost-source.js ./
COPY payroll-refund-aware-calculation.js payroll-refund-aware-source.js payroll-refund-aware-sourced-comparison.js ./
COPY payroll-refund-aware-snapshot.js payroll-refund-aware-provenance.js ./
COPY payroll-calculation-entry-transition-command.js payroll-calculation-entry-corrections.js ./
COPY payroll-calculation-entry-lifecycle.js ./
COPY payroll-unpaid-run-supersession.js ./
COPY payroll-correction-ledger-source.js payroll-refund-aware-paid-review-assessment.js payroll-refund-aware-paid-review-source.js payroll-refund-aware-correction-policy.js ./
COPY payroll-refund-aware-correction-store.js ./
COPY payroll-calculator-replay.js ./
COPY effective-permissions.js order-preparation.js reservation-calendar.js ./
COPY staff-schedule-domain.js staff-schedule-access.js staff-schedule-service.js staff-schedule-routes.js staff-schedule-personal.js ./
COPY staff-schedule-ui.js staff-schedule-ui.css staff-schedule-personal-ui.js ./
COPY staff-attendance-domain.js staff-attendance-access.js staff-attendance-service.js staff-attendance-mutations.js staff-attendance-routes.js ./
COPY staff-attendance-ui.js staff-attendance-ui.css help-content.js ./
COPY staff-attendance-notifications.js ./
COPY staff-schedule-copy.js ./
COPY staff-schedule-planning.js staff-schedule-pattern.js staff-schedule-planning-ui.js ./
COPY staff-schedule-availability.js staff-schedule-settings.js staff-schedule-defaults.js staff-schedule-bindings.js ./
COPY staff-schedule-coverage.js staff-schedule-demand.js staff-schedule-demand-domain.js staff-schedule-series.js staff-schedule-series-domain.js staff-schedule-venue-policy.js ./
COPY table-minimum-schedule.js ./
COPY ui-dialog.js ./
COPY management-theme.js management-theme.css ./
COPY pos-order-pricing-sql.js ./
COPY staff-identity.js ./
COPY auth-smoke.js auth-smoke.css ./
COPY platform.js staff-profile.js staff-display-name.js staff-audit.js staff-phone-fields.js staff-sensitive-fields.js staff-admin-card.js staff-telegram-link.js vip-deposit.js vip-deposit-ui.js ./
COPY scripts ./scripts
COPY migrations ./migrations
EXPOSE 3000
CMD ["node","server.js"]
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
