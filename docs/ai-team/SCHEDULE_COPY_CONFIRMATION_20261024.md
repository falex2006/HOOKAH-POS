# U2: подтверждение копирования относится к текущим параметрам

Исходный copyWeek scope графика, поверх0fc29f2b. MASTER независимо прочитал sticky confirmWarnings baseline. BrowserRED воспроизвёл8 несовпадений на390/1440: после409 и подтверждённого повтора true переносилось на изменённый выбор строк, reason, даты/preview и новый fingerprint. Первое false и явный неизменённый повтор true работали и не объявлены дефектами.

Минимальная JS/dist правка: resetConfirmation на reason input, selection change, invalidate параметров и начале нового preview. Он сбрасывает flag и label, создаёт новый requestKey для изменённого действия. После409 кнопка явно «Подтвердить копирование»; пояснение просит проверить даты/записи и причину, не ссылается на невидимые подробности. Reason label теперь отражает существующий backend: staff-schedule-copy.js требует причину для shift и прошлых дат. Server/roles/body format/CSS не менялись.

ScheduleError и route передают только code/status, без warningsdetails; дополнительные детали в UI не выдумываются. Продуктовая правка не добавляет новый механизм согласования и не изменяет backend-инварианты, а ограничивает существующее согласие текущим действием.

## Проверки

scripts/staff-schedule-copy-confirmation-browser-qa.cjs: actual mounted JS/CSS, syntheticcopyAPI, source16/dist16 observations PASS390/1440, baseline12 observations/8issues сохранены отдельно. PayloadA false→неизменённый explicitrepeat true; B после четырёх изменений снова false. Конфликтный sourcec disabled/unchecked и отсутствует в POST. Отдельный confirmed503→неизменённый retry сохраняет весь body/requestKey/confirmtrue; это не uncertain-commit доказательство. Snapshot dialog bounds/scrollWidth, верх и footer warning-actions на двух ширинах. Root осмотрел390/1440: reason, сообщение, Close и явное подтверждение помещаются. Lifecycle9/discard/graphite/syntax/diff/source-dist parity PASS, terminal24096exit0.

Это компонентное доказательство UI payload, не настоящая массовая запись/PG/RBAC. Actual attendance journey69 был выполнен на frozence4f10b7 до этой новой copyWeek правки; его PASS не распространяется на неё. Остальной planning/customACL/realcopy lifecycle и полный U2 остаются открыты. Production/GitHub/VPS не менялись; PG не запускался.

MASTER independently reviewed baseline/final diff and backend reason contract, reran dist16PASS/issues[], visually opened warning-actions390 and gave scoped GO. Root inspected390/1440. No independent1440 claim until separately confirmed; no realcopyPG/wholegoal claim.
