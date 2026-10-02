'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const decodeId = (value) => {
  try { return decodeURIComponent(value); } catch (_) { return ''; }
};

const sameOriginMutation = (req) => {
  if (/^Bearer\s+/i.test(String(req.headers?.authorization || ''))) return true;
  const origin = String(req.headers?.origin || '');
  const host = String(req.headers?.host || '').trim().toLowerCase();
  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (!origin || !host || (fetchSite && fetchSite !== 'same-origin')) return false;
  try {
    const parsed = new URL(origin);
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const protocol = forwardedProto === 'https' || (!forwardedProto && req.socket?.encrypted) ? 'https:' : 'http:';
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.protocol === protocol && parsed.host.toLowerCase() === host;
  } catch (_) { return false; }
};

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const handlePayrollSchemeRoute = async ({ req, res, url, service, readBody, json }) => {
  const pathname = url?.pathname || '';
  const schemeIdPath = pathname.match(/^\/api\/payroll\/schemes\/([^/]+)\/versions$/);
  const versionActionPath = pathname.match(/^\/api\/payroll\/versions\/([^/]+)(?:\/(revisions|activate|preview))?$/);
  const isCollection = pathname === '/api/payroll/schemes';
  const isCompare = pathname === '/api/payroll/compare';
  if (!isCollection && !schemeIdPath && !versionActionPath && !isCompare) return false;

  if (!req.user) { json(res, 401, { error: 'authentication_required' }); return true; }
  const principal = { userId: req.user.id, venueId: req.user.venueId };
  // Refuse non-owner roles before touching payroll configuration or returning
  // whether a scheme/version exists. The service repeats this check against DB.
  if (req.user.role !== 'owner') { json(res, 403, { error: 'payroll_scheme_owner_only' }); return true; }
  if (!UUID.test(String(principal.userId || '')) || !UUID.test(String(principal.venueId || ''))) {
    json(res, 403, { error: 'payroll_scheme_owner_only' }); return true;
  }
  if (!service) { json(res, 503, { error: 'payroll_scheme_database_required' }); return true; }

  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
  if (write && !sameOriginMutation(req)) { json(res, 403, { error: 'same_origin_required' }); return true; }

  let id = '';
  if (schemeIdPath) id = decodeId(schemeIdPath[1]);
  if (versionActionPath) id = decodeId(versionActionPath[1]);
  if (id && !UUID.test(id)) { json(res, 400, { error: schemeIdPath ? 'invalid_payroll_scheme_id' : 'invalid_payroll_scheme_version_id' }); return true; }

  const inputForWrite = async () => {
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw Object.assign(new Error('json_content_type_required'), { status: 415, code: 'json_content_type_required' });
    try {
      const input = await readBody(req);
      if (!isObject(input)) throw Object.assign(new Error('invalid_json_body'), { status: 400, code: 'invalid_json_body' });
      return input;
    } catch (error) {
      if (error?.status) throw error;
      if (error instanceof SyntaxError) throw Object.assign(new Error('invalid_json_body'), { status: 400, code: 'invalid_json_body' });
      if (error?.code === 'payload_too_large') throw Object.assign(new Error('payload_too_large'), { status: 413, code: 'payload_too_large' });
      throw Object.assign(new Error('invalid_json_body'), { status: 400, code: 'invalid_json_body' });
    }
  };

  try {
    if (isCollection && req.method === 'GET') {
      json(res, 200, { items: await service.listSchemes(principal) }); return true;
    }
    if (isCollection && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 201, await service.createScheme(principal, input)); return true;
    }
    if (schemeIdPath && req.method === 'GET') {
      const schemes = await service.listSchemes(principal);
      const scheme = schemes.find((item) => item.id === id);
      if (!scheme) json(res, 404, { error: 'payroll_scheme_not_found' });
      else json(res, 200, { items: scheme.versions || [] });
      return true;
    }
    if (schemeIdPath && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 201, await service.createVersion(principal, id, input.definition)); return true;
    }
    if (isCompare && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.compare(principal, input.versionIds, input.previewInput, input.baselineVersionId)); return true;
    }
    if (versionActionPath && !versionActionPath[2] && req.method === 'GET') {
      json(res, 200, await service.getVersion(principal, id)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'revisions' && req.method === 'GET') {
      json(res, 200, { items: await service.listVersionRevisions(principal, id) }); return true;
    }
    if (versionActionPath && !versionActionPath[2] && req.method === 'PUT') {
      const input = await inputForWrite();
      json(res, 200, await service.replaceDraftVersion(principal, id, input.definition)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'activate' && req.method === 'POST') {
      json(res, 200, await service.activateVersion(principal, id)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'preview' && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.preview(principal, id, input.previewInput)); return true;
    }
    return false;
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 499 ? error.status : 503;
    const code = error?.code && /^[a-z0-9_]{1,100}$/.test(error.code)
      ? error.code
      : status === 503 ? 'payroll_scheme_unavailable' : 'invalid_payroll_scheme_request';
    json(res, status, { error: code });
    return true;
  }
};

module.exports = { handlePayrollSchemeRoute, sameOriginMutation };
