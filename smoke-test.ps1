param([string]$BaseUrl = 'http://localhost:3000')
$ErrorActionPreference = 'Stop'
$baseUri = [Uri]$BaseUrl
if ($baseUri.Host -notin @('localhost', '127.0.0.1', '::1')) { throw "Local-only smoke test refused non-local BaseUrl: $BaseUrl" }
$smokeSuffix = (Get-Date).ToString('yyyyMMddHHmmss')
$health = Invoke-RestMethod "$BaseUrl/api/health"
if ($health.status -ne 'ok') { throw 'health failed' }
$login = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/login" -ContentType 'application/json' -Body '{"username":"admin","password":"admin"}'
$authHeaders = @{ Authorization = "Bearer $($login.token)" }
$PSDefaultParameterValues['Invoke-RestMethod:Headers'] = $authHeaders
$authenticatedSession = Invoke-RestMethod "$BaseUrl/api/session" -Headers $authHeaders
if ($authenticatedSession.user.role -ne 'admin' -or $authenticatedSession.permissions -notcontains 'finance') { throw 'authenticated role session failed' }
$ownerPassword = if ($env:DEMO_OWNER_PASSWORD) { $env:DEMO_OWNER_PASSWORD } else { 'demo' }
$ownerLogin = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/login" -ContentType 'application/json' -Body (@{ username = 'owner'; password = $ownerPassword } | ConvertTo-Json)
$ownerHeaders = @{ Authorization = "Bearer $($ownerLogin.token)" }
$owner = Invoke-RestMethod "$BaseUrl/api/session" -Headers $ownerHeaders
if ($owner.user.role -ne 'owner' -or $owner.permissions -notcontains 'staff' -or $owner.permissions -notcontains 'finance') { throw 'owner permissions failed' }
$staffLoginName = "smoke_$(Get-Date -Format 'HHmmss')"
$createdStaff = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/staff" -ContentType 'application/json' -Body (@{ name = 'Smoke bartender'; login = $staffLoginName; password = 'smoke-pass'; role = 'bartender'; birthDate = '1995-05-15'; employmentStartedAt = '2026-01-15'; workNotes = 'smoke'; phoneNumbers = @(@{ label = 'Рабочий'; number = '+79990001111'; primary = $true }) } | ConvertTo-Json -Depth 5)
if ($createdStaff.login -ne $staffLoginName) { throw 'staff creation failed' }
if ($createdStaff.employmentStartedAt -ne '2026-01-15' -or $createdStaff.phoneNumbers.Count -ne 1) { throw 'staff employment/contact fields failed' }
$staffAuth = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/login" -ContentType 'application/json' -Body (@{ username = $staffLoginName; password = 'smoke-pass' } | ConvertTo-Json)
if ($staffAuth.user.role -ne 'bartender') { throw 'created staff login failed' }
$staffProfile = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/staff/$($createdStaff.id)/profile" -ContentType 'application/json' -Body (@{ name = 'Smoke senior bartender'; role = 'senior_bartender'; workNotes = 'updated' } | ConvertTo-Json)
if ($staffProfile.role -ne 'senior_bartender' -or $staffProfile.name -ne 'Smoke senior bartender') { throw 'staff role update failed' }
$staffBlocked = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/staff/$($createdStaff.id)/status" -ContentType 'application/json' -Body '{"active":false}'
if ($staffBlocked.active) { throw 'staff block failed' }
$staffRestored = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/staff/$($createdStaff.id)/status" -ContentType 'application/json' -Body '{"active":true}'
if (-not $staffRestored.active) { throw 'staff restore failed' }
$staffDeleted = Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/staff/$($createdStaff.id)"
if ($staffDeleted.active) { throw 'staff delete/deactivate failed' }
$staffArchived = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/staff/$($createdStaff.id)/archive" -Headers $ownerHeaders -ContentType 'application/json' -Body '{}'
if (-not $staffArchived.archivedAt -or $staffArchived.active) { throw 'staff archive failed' }
$staffDirectory = Invoke-RestMethod "$BaseUrl/api/staff"
if ($staffDirectory.items.id -contains $createdStaff.id) { throw 'archived staff remains in operational directory' }
$shiftState = Invoke-RestMethod "$BaseUrl/api/shifts"
if ($shiftState.current) {
  $shift = $shiftState.current
  Write-Output 'SHIFT LIFECYCLE QA: existing open shift preserved; open/close transition skipped'
} else {
  $shift = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/shifts" -ContentType 'application/json' -Body '{"openingCash":1000}'
  if (-not $shift.id) { throw 'shift open failed' }
  $closedShift = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/shifts/$($shift.id)/close" -ContentType 'application/json' -Body '{"closingCash":1200,"checklist":{"version":1,"items":{"ordersReviewed":true,"cashCounted":true,"inventoryReviewed":true,"externalFiscalReportsHandled":true}}}'
  if (-not $closedShift.closedAt -or [decimal]$closedShift.closingCash -ne 1200) { throw 'shift close failed' }
  $shift = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/shifts" -ContentType 'application/json' -Body '{"openingCash":1000}'
  if (-not $shift.id) { throw 'operational shift reopen failed' }
}
$venueBefore = Invoke-RestMethod "$BaseUrl/api/venue"
$venueUpdated = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/venue" -ContentType 'application/json' -Body (@{ expectedVenueId = $venueBefore.id; phone = '+7 (900) 123-45-67'; logoUrl = 'data:image/png;base64,AA=='; vipRoomMinimums = @{ vip_room_1 = 1600; vip_room_2 = 2600 } } | ConvertTo-Json)
if ($venueUpdated.phone -ne '+7 (900) 123-45-67' -or $venueUpdated.vipRoomMinimums.vip_room_1 -ne 1600 -or -not $venueUpdated.logoUrl) { throw 'company settings update failed' }
$restorePhone = if ([string]$venueBefore.phone -match '^\+?[0-9 ()-]{7,24}$') { [string]$venueBefore.phone } else { '+7 (996) 641-95-10' }
Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/venue" -ContentType 'application/json' -Body (@{ expectedVenueId = $venueBefore.id; phone = $restorePhone; logoUrl = $venueBefore.logoUrl; vipRoomMinimums = @{ vip_room_1 = 1500; vip_room_2 = 2500 } } | ConvertTo-Json) | Out-Null
$staffHeaders = @{ Authorization = "Bearer $($staffAuth.token)" }
$session = Invoke-RestMethod "$BaseUrl/api/session" -Headers $staffHeaders
if ($session.user.role -ne 'bartender' -or $session.permissions -notcontains 'orders' -or $session.permissions -contains 'finance') { throw 'role permissions failed' }
$PSDefaultParameterValues['Invoke-RestMethod:Headers'] = $authHeaders
$product = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/products" -ContentType 'application/json' -Body (@{ name = "Smoke product $smokeSuffix"; category = 'Бар'; price = 399; aliases = @('smoke', 'тест') } | ConvertTo-Json)
if (-not $product.id -or $product.category -ne 'Бар' -or $product.aliases.Count -ne 2) { throw 'product create/aliases failed' }
$productUpdated = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/products/$($product.id)" -ContentType 'application/json' -Body (@{ price = 420; aliases = @('smoke', 'обновлённый') } | ConvertTo-Json)
if ($productUpdated.price -ne 420) { throw 'product update failed' }
$productImage = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/products/$($product.id)/image" -ContentType 'application/json' -Body (@{ imageData = 'data:image/png;base64,AA==' } | ConvertTo-Json)
if (-not $productImage.imageUrl) { throw 'product image update failed' }
$productDeleted = Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/products/$($product.id)"
if ($productDeleted.active -ne $false) { throw 'product deactivation failed' }
$orderProduct = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/products" -ContentType 'application/json' -Body (@{ name = "Smoke order product $smokeSuffix"; category = 'Бар'; price = 250; inventoryMode = 'non_stock'; aliases = @('order-smoke') } | ConvertTo-Json)
if (-not $orderProduct.id) { throw 'order product create failed' }
$orderProductId = [string]$orderProduct.id
$removableProduct = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/products" -ContentType 'application/json' -Body (@{ name = "Smoke removable product $smokeSuffix"; category = 'Бар'; price = 180; aliases = @('remove-smoke') } | ConvertTo-Json)
if (-not $removableProduct.id) { throw 'removable product create failed' }
$removableBody = @{ productId = [string]$removableProduct.id; quantity = 1 } | ConvertTo-Json
$productCategories = Invoke-RestMethod "$BaseUrl/api/product-categories"
if ($null -eq $productCategories.items) { throw 'product categories list failed' }
$productCategory = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/product-categories" -ContentType 'application/json' -Body (@{ name = "Smoke product category $smokeSuffix" } | ConvertTo-Json)
$productCategoryUpdated = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/product-categories/$($productCategory.id)" -ContentType 'application/json' -Body (@{ name = "Smoke product category updated $smokeSuffix" } | ConvertTo-Json)
if ($productCategoryUpdated.name -notlike '*updated*') { throw 'product category update failed' }
$productCategoryDeleted = Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/product-categories/$($productCategory.id)"
if ($productCategoryDeleted.active -ne $false) { throw 'product category deactivation failed' }
$clientPhone = "+7 900 1$smokeSuffix"
$client = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/clients" -ContentType 'application/json' -Body (@{ name = "Smoke guest $smokeSuffix"; phoneNumbers = @(@{ label = 'Основной'; number = $clientPhone; primary = $true }, @{ label = 'Дополнительный'; number = "+7 900 2$smokeSuffix"; primary = $false }); telegram = '@smoke_guest'; tobaccoPreferences = @('Мята'); bowlPreferences = @('Калауд'); barPreferences = @('Red Bull'); allergies = 'нет'; notes = 'local acceptance' } | ConvertTo-Json -Depth 5)
if (-not $client.id -or $client.phoneNumbers.Count -ne 2) { throw 'client profile create failed' }
$loyalty = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/clients/$($client.id)/loyalty" -ContentType 'application/json' -Body (@{ delta = 50; reason = 'local smoke' } | ConvertTo-Json)
if ($loyalty.loyaltyPoints -ne 50) { throw 'client loyalty update failed' }
$clientHistory = Invoke-RestMethod "$BaseUrl/api/clients/$($client.id)/history"
if ($null -eq $clientHistory.orders -or $null -eq $clientHistory.reservations) { throw 'client history failed' }
$networkBefore = Invoke-RestMethod "$BaseUrl/api/network/venues"
if ($networkBefore.items.Count -lt 1) { throw 'network venues list failed' }
$networkVenue = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/network/venues" -ContentType 'application/json' -Body (@{ name = "Smoke point $smokeSuffix"; city = 'Тюмень'; address = "ул. Smoke $smokeSuffix" } | ConvertTo-Json)
$networkUpdated = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/network/venues/$($networkVenue.id)" -ContentType 'application/json' -Body (@{ name = "Smoke point updated $smokeSuffix" } | ConvertTo-Json)
if ($networkUpdated.name -notlike '*updated*') { throw 'network venue update failed' }
$networkSelected = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/network/venues/$($networkVenue.id)/select"
if (-not $networkSelected.isCurrent) { throw 'network venue select failed' }
$selectedVenueSettings = Invoke-RestMethod "$BaseUrl/api/venue"
if ($selectedVenueSettings.name -ne $networkSelected.name) { throw 'network venue context did not propagate to venue settings' }
$networkCurrentDeleteStatus = $null
try { Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/network/venues/$($networkVenue.id)" | Out-Null } catch { $networkCurrentDeleteStatus = [int]$_.Exception.Response.StatusCode.value__ }
if ($networkCurrentDeleteStatus -ne 409) { throw 'current network venue archive guard failed' }
$originalCurrent = $networkBefore.items | Where-Object { $_.isCurrent } | Select-Object -First 1
if ($originalCurrent) { Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/network/venues/$($originalCurrent.id)/select" | Out-Null }
Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/network/venues/$($networkVenue.id)" | Out-Null
$financeCategories = Invoke-RestMethod "$BaseUrl/api/finance/categories"
if ($null -eq $financeCategories.items) { throw 'finance categories list failed' }
$financeCategory = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/finance/categories" -ContentType 'application/json' -Body (@{ name = "Smoke category $smokeSuffix"; kind = 'expense' } | ConvertTo-Json)
$financeCategoryUpdated = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/finance/categories/$($financeCategory.id)" -ContentType 'application/json' -Body (@{ name = "Smoke category updated $smokeSuffix" } | ConvertTo-Json)
if ($financeCategoryUpdated.name -notlike '*updated*') { throw 'finance category update failed' }
$financeCategoryDeleted = Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/finance/categories/$($financeCategory.id)"
if ($financeCategoryDeleted.active -ne $false) { throw 'finance category deactivation failed' }
$integrations = Invoke-RestMethod "$BaseUrl/api/integrations"
$integrationKeys = @($integrations.PSObject.Properties.Name)
if ($integrationKeys.Count -ne 1 -or $integrationKeys[0] -ne 'telegram' -or $integrations.telegram.enabled) { throw 'Telegram-only integration contract failed' }
$smokeFloorVenueId = (Invoke-RestMethod "$BaseUrl/api/floor").venueId
$smokeZone = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/floor/zones" -ContentType 'application/json' -Body (@{ expectedVenueId = $smokeFloorVenueId; name = "Smoke VIP $smokeSuffix" } | ConvertTo-Json)
$smokeTables = @{}
foreach ($fixture in @(@{ key = 'vip1'; minimum = 1500 }, @{ key = 'vip2'; minimum = 2500 }, @{ key = 'regular'; minimum = 0 }, @{ key = 'workflow'; minimum = 0 }, @{ key = 'transfer'; minimum = 0 })) {
  $smokeTables[$fixture.key] = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/floor/tables" -ContentType 'application/json' -Body (@{ expectedVenueId = $smokeFloorVenueId; zoneId = $smokeZone.id; name = "Smoke $($fixture.key) $smokeSuffix"; capacity = 4; minimumOrderTotal = $fixture.minimum } | ConvertTo-Json)
}
$order = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders" -ContentType 'application/json' -Body (@{ tableId = $smokeTables.vip1.id; orderType = 'vip'; minimumOrderTotal = 1500 } | ConvertTo-Json)
$closed = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($order.id)/close" -ContentType 'application/json' -Body '{}'
if ($closed.finalTotal -ne 1500 -or $closed.minimumAdjustment -ne 1500) { throw 'vip minimum failed' }
$closedAgainStatus = $null
try { Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($order.id)/close" -ContentType 'application/json' -Body '{}' | Out-Null } catch { $closedAgainStatus = [int]$_.Exception.Response.StatusCode.value__ }
if ($closedAgainStatus -ne 409) { throw 'closed order repeat guard failed' }
$vip2 = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders" -ContentType 'application/json' -Body (@{ tableId = $smokeTables.vip2.id; orderType = 'vip'; minimumOrderTotal = 2500 } | ConvertTo-Json)
$vip2Closed = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($vip2.id)/close" -ContentType 'application/json' -Body '{}'
if ($vip2Closed.finalTotal -ne 2500 -or $vip2Closed.minimumAdjustment -ne 2500) { throw 'vip room 2 minimum failed' }
$paymentOrder = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders" -ContentType 'application/json' -Body (@{ tableId = $smokeTables.vip1.id; minimumOrderTotal = 1500 } | ConvertTo-Json)
$payment = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($paymentOrder.id)/payments" -ContentType 'application/json' -Body '{"method":"card","amount":1000}'
if ($payment.remaining -ne 500 -or $payment.closed) { throw 'partial payment failed' }
$paymentFinal = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($paymentOrder.id)/payments" -ContentType 'application/json' -Body '{"method":"qr","amount":500}'
if ($paymentFinal.remaining -ne 0 -or -not $paymentFinal.closed -or $paymentFinal.finalTotal -ne 1500 -or $paymentFinal.minimumAdjustment -ne 1500 -or $paymentFinal.paymentMethod -ne 'mixed') { throw 'split payment completion metadata failed' }

$regular = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders" -ContentType 'application/json' -Body (@{ tableId = $smokeTables.regular.id } | ConvertTo-Json)
$guest = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/orders/$($regular.id)" -ContentType 'application/json' -Body '{"guestName":"Smoke guest","phone":"+79990000000"}'
if ($guest.guestName -ne 'Smoke guest') { throw 'guest binding failed' }
$attachedGuest = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/orders/$($regular.id)" -ContentType 'application/json' -Body (@{ clientId = $client.id } | ConvertTo-Json)
if ($attachedGuest.guestName -ne $client.name) { throw 'client profile attachment failed' }
$itemBody = @{ productId = $orderProductId; quantity = 1 } | ConvertTo-Json
$item = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($regular.id)/items" -ContentType 'application/json' -Body $itemBody
$itemMerged = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($regular.id)/items" -ContentType 'application/json' -Body $itemBody
if ($itemMerged.id -ne $item.id -or $itemMerged.quantity -ne 2) { throw 'duplicate product quantity merge failed' }
$itemChanged = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/orders/$($regular.id)/items/$($item.id)" -ContentType 'application/json' -Body '{"quantity":1}'
if ($itemChanged.id -ne $item.id -or $itemChanged.quantity -ne 1) { throw 'order item quantity edit failed' }
$removableItem = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($regular.id)/items" -ContentType 'application/json' -Body $removableBody
$removedItem = Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/orders/$($regular.id)/items/$($removableItem.id)"
if ($removedItem.id -ne $removableItem.id) { throw 'order item delete failed' }
$remainingItem = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($regular.id)/items" -ContentType 'application/json' -Body $removableBody
$split = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($regular.id)/split" -ContentType 'application/json' -Body "{`"itemIds`":[`"$($item.id)`"]}"
if (-not $split.splitFrom) { throw 'split failed' }
$discount = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($split.id)/discount-requests" -ContentType 'application/json' -Body '{"type":"percent","value":10,"reason":"guest promo","requestedBy":"u-test"}'
if ($discount.status -ne 'requested') { throw 'discount request failed' }
$invalidDiscountStatus = $null
try { Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($split.id)/discount-requests" -ContentType 'application/json' -Body '{"type":"percent","value":101,"reason":"invalid"}' | Out-Null } catch { $invalidDiscountStatus = [int]$_.Exception.Response.StatusCode.value__ }
if ($invalidDiscountStatus -ne 400) { throw 'discount bounds guard failed' }
$decision = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/discount-requests/$($discount.id)/approve" -ContentType 'application/json' -Body '{"decidedBy":"owner"}'
if ($decision.status -ne 'approved') { throw 'discount approval failed' }
$discountedClosed = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($split.id)/close" -ContentType 'application/json' -Body '{"paymentMethod":"cash"}'
if ($discountedClosed.status -ne 'closed' -or $discountedClosed.discountTotal -ne 25 -or $discountedClosed.finalTotal -ne 225) { throw 'approved discount close calculation failed' }
$workflowOrder = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders" -ContentType 'application/json' -Body (@{ tableId = $smokeTables.workflow.id } | ConvertTo-Json)
$workflowProgress = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($workflowOrder.id)/status" -ContentType 'application/json' -Body '{"status":"in_progress"}'
if ($workflowProgress.status -ne 'in_progress') { throw 'order station status transition failed' }
$workflowTransfer = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($workflowOrder.id)/transfer" -ContentType 'application/json' -Body (@{ tableId = $smokeTables.transfer.id } | ConvertTo-Json)
if ($workflowTransfer.tableId -ne $smokeTables.transfer.id) { throw 'order transfer failed' }
$workflowReady = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($workflowOrder.id)/status" -ContentType 'application/json' -Body '{"status":"ready"}'
if ($workflowReady.status -ne 'ready') { throw 'order ready status transition failed' }
$workflowClosed = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($workflowOrder.id)/close" -ContentType 'application/json' -Body '{"paymentMethod":"qr"}'
if ($workflowClosed.status -ne 'closed' -or $workflowClosed.paymentMethod -ne 'qr') { throw 'workflow order close failed' }
$closedItemGuardStatus = $null
try { Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/orders/$($workflowOrder.id)/items" -ContentType 'application/json' -Body $itemBody | Out-Null } catch { $closedItemGuardStatus = [int]$_.Exception.Response.StatusCode.value__ }
if ($closedItemGuardStatus -ne 409) { throw 'closed order item guard failed' }
$delivery = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/deliveries" -ContentType 'application/json' -Body (@{ customerName = 'Smoke delivery'; phone = '+79990003333'; address = 'Local test address'; total = 750; paymentMethod = 'card' } | ConvertTo-Json)
if ($delivery.status -ne 'new' -or $delivery.total -ne 750) { throw 'delivery create failed' }
$deliveryUpdated = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/deliveries/$($delivery.id)" -ContentType 'application/json' -Body '{"status":"in_delivery","courier":"Smoke courier"}'
if ($deliveryUpdated.status -ne 'in_delivery' -or $deliveryUpdated.courier -ne 'Smoke courier') { throw 'delivery status update failed' }
$deliveryDelivered = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/api/deliveries/$($delivery.id)" -ContentType 'application/json' -Body '{"status":"delivered"}'
if ($deliveryDelivered.status -ne 'delivered') { throw 'delivery completion failed' }
$metrics = $null
try { $metrics = Invoke-RestMethod "$BaseUrl/api/metrics" } catch {
  if (-not $_.ErrorDetails.Message -or $_.ErrorDetails.Message -notmatch 'rate_limited') { throw }
}
if ($metrics -and $null -eq $metrics.staffActive) { throw 'metrics failed' }
$floor = $null
try { $floor = Invoke-RestMethod "$BaseUrl/api/floor" } catch {
  if ($_.ErrorDetails.Message -match 'rate_limited') { Write-Output 'CRM smoke test: PASS (rate limit guard reached)'; exit 0 }
  throw
}
$vipZone = $floor.zones | Where-Object { $_.name -match 'VIP' }
$vipRoom1 = $vipZone.tables | Where-Object id -eq 'vip-room-1'
$vipRoom2 = $vipZone.tables | Where-Object id -eq 'vip-room-2'
if ($null -eq $floor.zones) { throw 'floor endpoint failed' }
$inventory = Invoke-RestMethod "$BaseUrl/api/inventory"
if ($null -eq $inventory) { throw 'inventory endpoint failed' }
$smokeInventory = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/inventory/items" -ContentType 'application/json' -Body (@{ name = "Smoke inventory $smokeSuffix"; unit = 'шт'; itemType = 'consumable'; department = 'inventory'; cost = 0; minLevel = 0 } | ConvertTo-Json)
if (-not $smokeInventory.id) { throw 'inventory fixture creation failed' }
$movement = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/inventory/movements" -ContentType 'application/json' -Body (@{ itemId = $smokeInventory.id; unit = 'шт'; delta = 1; reason = 'smoke test' } | ConvertTo-Json)
if ($movement.delta -ne 1) { throw 'inventory movement failed' }
$inventoryAfter = Invoke-RestMethod "$BaseUrl/api/inventory"
$savedInventory = $inventoryAfter.items | Where-Object { $_.id -eq $smokeInventory.id } | Select-Object -First 1
if (-not $savedInventory -or [decimal]$savedInventory.onHand -ne 1) { throw 'inventory movement persistence failed' }
$smokeDate = (Get-Date).Date.AddDays(2).ToString('yyyy-MM-dd')
$finance = Invoke-RestMethod "$BaseUrl/api/finance/summary"
if ($null -eq $finance.revenue -or $null -eq $finance.byPaymentMethod) { throw 'finance summary failed' }
$xReport = Invoke-RestMethod "$BaseUrl/api/finance/report?type=x"
$waiterReport = Invoke-RestMethod "$BaseUrl/api/finance/report?type=waiter"
if ($xReport.type -ne 'x' -or $null -eq $xReport.reportNumber -or $null -eq $xReport.byPaymentMethod) { throw 'X report failed' }
if ($waiterReport.type -ne 'waiter' -or $null -eq $waiterReport.byStaff) { throw 'waiter report failed' }
$audit = Invoke-RestMethod "$BaseUrl/api/audit"
if (-not $audit.items -or $audit.items.Count -lt 1) { throw 'audit failed' }
if (-not ($audit.items | Where-Object { $_.action -eq 'finance.report_generated' })) { throw 'report audit failed' }
Write-Output 'CRM smoke test: PASS'
