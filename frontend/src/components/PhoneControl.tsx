import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

interface PhoneNic {
  ip: string;
  iface: string;
  kind: 'wifi' | 'ethernet' | 'virtual' | 'other';
  primary: boolean;
}

interface PhoneInfo {
  port: number;
  lan_ips: string[];
  nics?: PhoneNic[];
  pin: string;
  lan_enabled?: boolean;
  last_phone_hit_ago_s?: number | null;
}

interface PhoneControlButtonProps {
  showToast?: (msg: string) => void;
}

const API = 'http://127.0.0.1:8777';

const PhoneControlButton: React.FC<PhoneControlButtonProps> = ({ showToast }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  // LAN listener (phone control exposure) state. Off by default each
  // session — the backend never persists it across restarts.
  const [lanEnabled, setLanEnabled] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/api/phone/info`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: PhoneInfo = await r.json();
      setInfo(j);
      if (typeof j.lan_enabled === 'boolean') setLanEnabled(j.lan_enabled);
      if (!selectedIp || !j.lan_ips.includes(selectedIp)) {
        setSelectedIp(j.lan_ips[0] ?? null);
      }
    } catch (e: any) {
      setErr(e?.message ?? 'failed');
    } finally {
      setLoading(false);
    }
  }, [selectedIp]);

  // On modal open, read the current LAN state first so the toggle renders
  // in the right position, then fetch URL/PIN info.
  const fetchLanStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/phone/lan_status`);
      if (r.ok) {
        const j = await r.json();
        setLanEnabled(!!j.enabled);
      }
    } catch { /* ignore — fetchInfo also reports lan_enabled */ }
  }, []);

  useEffect(() => {
    if (open) {
      fetchLanStatus();
      fetchInfo();
    }
  }, [open, fetchLanStatus, fetchInfo]);

  const toggleLan = useCallback(async () => {
    setLanBusy(true);
    setErr(null);
    try {
      const path = lanEnabled ? 'disable' : 'enable';
      const r = await fetch(`${API}/api/phone/${path}`, { method: 'POST' });
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          detail = j?.detail?.message || j?.detail || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      const nowEnabled = !lanEnabled;
      setLanEnabled(nowEnabled);
      showToast?.(t(nowEnabled ? 'phone.lan_enabled' : 'phone.lan_disabled'));
      await fetchInfo();
    } catch (e: any) {
      setErr(e?.message ?? 'failed');
    } finally {
      setLanBusy(false);
    }
  }, [lanEnabled, fetchInfo, showToast, t]);

  const rotate = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/phone/rotate`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await fetchInfo();
      showToast?.(t('phone.rotated'));
    } catch (e: any) {
      setErr(e?.message ?? 'failed');
    } finally {
      setLoading(false);
    }
  }, [fetchInfo, showToast, t]);

  const copy = useCallback(async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      showToast?.(t('phone.copied'));
    } catch { /* ignore */ }
  }, [showToast, t]);

  const url = info && selectedIp ? `http://${selectedIp}:${info.port}/phone` : '';

  const [fwState, setFwState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  const [fwMsg, setFwMsg] = useState<string>('');
  const repairFirewall = useCallback(async () => {
    setFwState('busy');
    setFwMsg('');
    try {
      const r = await fetch(`${API}/api/phone/firewall_repair`, { method: 'POST' });
      const j = await r.json();
      if (j.ok) {
        setFwState('ok');
        setFwMsg(t('phone.firewall_repair_ok'));
        showToast?.(t('phone.firewall_repair_ok'));
      } else {
        setFwState('fail');
        setFwMsg(j.message || t('phone.firewall_repair_failed'));
      }
    } catch (e: any) {
      setFwState('fail');
      setFwMsg(e?.message || t('phone.firewall_repair_failed'));
    }
    setTimeout(() => setFwState('idle'), 4500);
  }, [showToast, t]);

  // Poll while modal open so the "phone reached the URL" indicator lights
  // up live when the user actually opens the link on their phone.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(fetchInfo, 2000);
    return () => clearInterval(id);
  }, [open, fetchInfo]);

  const reachAgo = info?.last_phone_hit_ago_s;
  const reachOk = typeof reachAgo === 'number' && reachAgo < 60;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('phone.tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          fontSize: 12,
          background: 'rgba(77, 210, 138, 0.12)',
          border: '1px solid rgba(77, 210, 138, 0.4)',
          color: '#4dd28a',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="6" y="2" width="12" height="20" rx="2" />
          <line x1="11" y1="18" x2="13" y2="18" />
        </svg>
        {t('phone.button')}
      </button>

      {open && createPortal((
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(8, 10, 20, 0.55)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 420, maxWidth: 'calc(100vw - 32px)',
              background: 'rgba(26, 29, 39, 0.98)',
              border: '1px solid rgba(108, 140, 255, 0.3)',
              borderRadius: 12,
              padding: 22,
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              color: '#e6e8ee',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>{t('phone.modal_title')}</h2>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: 'transparent', border: 'none', color: '#97a0b3',
                  cursor: 'pointer', fontSize: 18, padding: '0 4px',
                }}
              >×</button>
            </div>

            <div style={{ fontSize: 12, color: '#97a0b3', lineHeight: 1.6, marginBottom: 14 }}>
              {t('phone.help')}
            </div>

            {loading && !info && <div style={{ fontSize: 13 }}>{t('generic.loading')}…</div>}
            {err && <div style={{ color: '#ef5d5d', fontSize: 13 }}>{err}</div>}

            {info && (
              <>
                {/* Enable / disable the LAN listener. Until enabled, phone
                    control is not reachable from the network at all. */}
                <button
                  onClick={toggleLan}
                  disabled={lanBusy}
                  style={{
                    width: '100%', marginBottom: 14, padding: '10px 12px',
                    fontSize: 13, fontWeight: 600,
                    background: lanEnabled ? 'rgba(239, 93, 93, 0.12)' : 'rgba(77, 210, 138, 0.14)',
                    border: `1px solid ${lanEnabled ? 'rgba(239, 93, 93, 0.45)' : 'rgba(77, 210, 138, 0.5)'}`,
                    color: lanEnabled ? '#ef9999' : '#7ee2a4',
                    borderRadius: 8, cursor: lanBusy ? 'wait' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: lanEnabled ? '#4dd28a' : '#6b7280',
                    boxShadow: lanEnabled ? '0 0 6px #4dd28a' : 'none',
                  }} />
                  {lanBusy
                    ? t(lanEnabled ? 'phone.disabling' : 'phone.enabling')
                    : t(lanEnabled ? 'phone.disable' : 'phone.enable')}
                </button>

                {!lanEnabled && (
                  <div style={{
                    fontSize: 11.5, lineHeight: 1.6, color: '#c9a86a',
                    background: 'rgba(255, 180, 60, 0.08)',
                    border: '1px solid rgba(255, 180, 60, 0.25)',
                    borderRadius: 8, padding: '10px 12px', marginBottom: 14,
                  }}>
                    {t('phone.lan_off_hint')}
                  </div>
                )}

                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16,
                  opacity: lanEnabled ? 1 : 0.45,
                  pointerEvents: lanEnabled ? 'auto' : 'none',
                }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#97a0b3', marginBottom: 4 }}>
                      {t('phone.lan_url')}
                    </div>
                    {(info.nics && info.nics.filter((n) => n.kind !== 'virtual').length > 1) ? (
                      <select
                        value={selectedIp ?? ''}
                        onChange={(e) => setSelectedIp(e.target.value)}
                        style={{
                          width: '100%', marginBottom: 6, padding: '4px 6px',
                          background: '#0f1218', color: '#e6e8ee',
                          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
                          fontSize: 12,
                        }}
                      >
                        {info.nics.filter((n) => n.kind !== 'virtual').map((n) => (
                          <option key={n.ip} value={n.ip}>
                            {n.ip} {n.iface ? `— ${n.iface}` : ''} {n.kind === 'wifi' ? '(Wi-Fi)' : n.kind === 'ethernet' ? '(Ethernet)' : ''} {n.primary ? '★' : ''}
                          </option>
                        ))}
                      </select>
                    ) : info.lan_ips.length > 1 && (
                      <select
                        value={selectedIp ?? ''}
                        onChange={(e) => setSelectedIp(e.target.value)}
                        style={{
                          width: '100%', marginBottom: 6, padding: '4px 6px',
                          background: '#0f1218', color: '#e6e8ee',
                          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
                          fontSize: 12,
                        }}
                      >
                        {info.lan_ips.map((ip) => (
                          <option key={ip} value={ip}>{ip}</option>
                        ))}
                      </select>
                    )}
                    <div
                      onClick={() => url && copy(url)}
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 14, color: '#6c8cff',
                        background: '#0f1218', padding: '10px 12px', borderRadius: 8,
                        cursor: url ? 'pointer' : 'default', wordBreak: 'break-all',
                        border: '1px solid rgba(255,255,255,0.08)',
                        textAlign: 'center', fontWeight: 500,
                      }}
                      title={t('phone.copy_url')}
                    >
                      {url || t('phone.no_lan')}
                    </div>
                  </div>

                  <div style={{
                    fontSize: 11, padding: '6px 10px', borderRadius: 6,
                    border: `1px solid ${reachOk ? 'rgba(77, 210, 138, 0.5)' : 'rgba(255,255,255,0.10)'}`,
                    background: reachOk ? 'rgba(77, 210, 138, 0.12)' : 'rgba(255,255,255,0.04)',
                    color: reachOk ? '#7ee2a4' : '#97a0b3',
                  }}>
                    {reachOk
                      ? t('phone.reach_ok', { sec: String(Math.max(0, Math.round(reachAgo as number))) })
                      : t('phone.reach_unknown')}
                  </div>

                  <div>
                    <div style={{ fontSize: 11, color: '#97a0b3', marginBottom: 4 }}>PIN</div>
                    <div
                      onClick={() => copy(info.pin)}
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 30, letterSpacing: 8, fontWeight: 600,
                        background: '#0f1218', padding: '14px 12px', borderRadius: 8,
                        textAlign: 'center', cursor: 'pointer',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                      title={t('phone.copy_pin')}
                    >
                      {info.pin}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                    <button
                      onClick={repairFirewall}
                      disabled={fwState === 'busy' || !lanEnabled}
                      title={t('phone.firewall_repair_tooltip')}
                      style={{
                        opacity: lanEnabled ? 1 : 0.4,
                        padding: '6px 10px', fontSize: 11,
                        background:
                          fwState === 'ok' ? 'rgba(77, 210, 138, 0.18)' :
                          fwState === 'fail' ? 'rgba(239, 93, 93, 0.18)' :
                          fwState === 'busy' ? 'rgba(108, 140, 255, 0.15)' :
                          'rgba(255, 180, 60, 0.12)',
                        border: `1px solid ${
                          fwState === 'ok' ? 'rgba(77, 210, 138, 0.55)' :
                          fwState === 'fail' ? 'rgba(239, 93, 93, 0.55)' :
                          fwState === 'busy' ? 'rgba(108, 140, 255, 0.45)' :
                          'rgba(255, 180, 60, 0.45)'}`,
                        color:
                          fwState === 'ok' ? '#7ee2a4' :
                          fwState === 'fail' ? '#ef9999' :
                          fwState === 'busy' ? '#9bb0ff' :
                          '#ffc870',
                        borderRadius: 4, cursor: fwState === 'busy' ? 'wait' : 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        alignSelf: 'flex-start',
                      }}
                    >
                      {fwState === 'busy' ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                        </svg>
                      ) : fwState === 'ok' ? (
                        <span style={{ fontSize: 13, fontWeight: 700 }}>✓</span>
                      ) : fwState === 'fail' ? (
                        <span style={{ fontSize: 13, fontWeight: 700 }}>✗</span>
                      ) : (
                        <span style={{ fontSize: 13, fontWeight: 700 }}>!</span>
                      )}
                      <span>
                        {fwState === 'busy' ? t('phone.firewall_repair_busy') :
                         fwState === 'ok' ? t('phone.firewall_repair_ok') :
                         fwState === 'fail' ? t('phone.firewall_repair_failed') :
                         t('phone.firewall_repair_button')}
                      </span>
                    </button>
                    {fwMsg && fwState !== 'idle' && (
                      <div style={{
                        fontSize: 10, lineHeight: 1.4,
                        color: fwState === 'fail' ? '#ef9999' : '#7ee2a4',
                        wordBreak: 'break-word',
                      }}>
                        {fwMsg}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={rotate}
                    disabled={loading}
                    style={{
                      padding: '6px 12px', fontSize: 12,
                      background: 'rgba(239, 93, 93, 0.12)',
                      border: '1px solid rgba(239, 93, 93, 0.4)',
                      color: '#ef5d5d', borderRadius: 4, cursor: 'pointer',
                    }}
                  >
                    {t('phone.rotate')}
                  </button>
                  <button
                    onClick={() => setOpen(false)}
                    style={{
                      padding: '6px 12px', fontSize: 12,
                      background: 'rgba(108, 140, 255, 0.18)',
                      border: '1px solid rgba(108, 140, 255, 0.4)',
                      color: '#6c8cff', borderRadius: 4, cursor: 'pointer',
                    }}
                  >
                    {t('generic.close')}
                  </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      ), document.body)}
    </>
  );
};

export default PhoneControlButton;
