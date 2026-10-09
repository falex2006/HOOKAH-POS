FROM node:20-alpine
ARG CRM_RELEASE_ID=unreleased
LABEL com.hookahpos.release-id=$CRM_RELEASE_ID
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY db.js server.js payroll.js recipe-depletion.js purchase-document-validation.js staff-avatar-image.js loyalty-pricing.js loyalty-memory-reconciliation.js payroll-scheme-service.js payroll-scheme-routes.js payroll-scheme-ui.js payroll-schemes.js payroll-venue-turnover-source.js order-attention.js shift-close-contract.js payroll-attendance-manifest.js payroll-canonical-pricing-source.js payroll-incentive-math.js payroll-item-return-source.js payroll-milestone-evidence.js payroll-order-pricing-evidence.js payroll-order-refund-evidence.js payroll-personal-cap-policy.js payroll-snapshot-evidence.js payroll-snapshot-reconciliation.js payroll-snapshot-source-context.js payroll-source-policies.js payroll-source-readiness.js index.html admin.html login.html inventory.html finance.html finance-categories.html finance-report.html reservations.html clients.html orders.html integrations.html network.html delivery.html platform.html admin.js style.css platform.css app.js portal.js portal-session.js header-shell.js login.js catalog-seed.js lock.js ./
COPY assets ./assets
COPY notification-center.js ./
COPY audit-privacy.js ./
COPY effective-permissions.js order-preparation.js reservation-calendar.js ./
COPY staff-identity.js ./
COPY auth-smoke.js auth-smoke.css ./
COPY platform.js staff-profile.js staff-display-name.js staff-audit.js staff-phone-fields.js staff-sensitive-fields.js staff-admin-card.js staff-telegram-link.js vip-deposit.js vip-deposit-ui.js ./
COPY scripts ./scripts
COPY migrations ./migrations
EXPOSE 3000
CMD ["node","server.js"]
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1


