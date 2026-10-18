# Finance palette acceptance — 2026-10-19

Root cause: management-theme.js recognized only the overview and payroll hashes. Switching to any other finance section removed the management theme. The resolver now recognizes all 11 sections and existing nested entry anchors, retaining permission and context exclusions.

Navigation uses a common panel, quiet inactive links, a soft accent fill plus bottom indicator for the selected section, distinct hover and keyboard focus. On narrow screens the existing labelled section picker remains. Financial panels and nested summaries use the common surface tokens in both themes.

## Evidence

Guarded Chromium run: acceptance-1792353983471-17720, palette-only scope, isolated synthetic PostgreSQL. PASS: 44 screenshots, 11 sections × 2 themes × 2 widths (1366/390), zero page errors. Screenshots captured after navigation transitions settled. Verified primary panel RGB 29,33,38 (dark) / 255,255,255 (light), no horizontal overflow, selected navigation, hover and keyboard focus, nested anchors, unknown-anchor and employee-role exclusions. Minimum active text contrast: 8.07 dark / 6.47 light; inactive: 10.10 / 7.62; hover: 12.89 / 11.90.

Actual resolver/session contract: 113 checks PASS. Syntax, semantic tokens, navigation contexts (58), sidebar, visual rules, local deploy contract, source/dist parity and git diff checks PASS. Architect/code-health review GO. Coordinator reviewed the three retained desktop/mobile screenshots.

This package changes presentation and theme-context selection only. No financial calculations, API or migrations changed. Broader transactional browser acceptance remains documented in ../finance-section-internals/ACCEPTANCE.md. No new GitHub/VPS publication is claimed.
