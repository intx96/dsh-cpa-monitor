/**
 * dsh-cpa-monitor — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step), mirroring the shape
 * the shipped and marketplace client plugins use: executing the script only
 * REGISTERS the factory, and every side effect — CSS injection included — lives
 * inside it, so it runs at materialization rather than at script arrival.
 *
 * Registers one `sidebar.footer.action` occupant: a status badge at the foot of
 * the left sidebar that opens a floating panel with every CPA Codex account.
 * Data comes from the server half's loopback-only routes via same-origin fetch.
 */
window.__ModuleLoader__.load({
	id: "dsh-cpa-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_dom = require("react-dom");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;

		//#region constants
		/** Locale namespace this plugin registers its dictionaries under. */
		const NS = "cpa-monitor";
		/**
		 * Key the Plugins-page row configuration registers under, which is exactly
		 * `<package.json name>#<cordis.patch.yml row id>`. The page only offers a
		 * row a configure control when this key is present, and it binds the form to
		 * the settings namespace whose name equals the row id — both are `NS`.
		 */
		const ROW_CONFIG_KEY = "dsh-cpa-monitor#cpa-monitor";
		/** CSS tag id; also the guard against injecting the sheet twice. */
		const TAG_ID = "dsh-cpa-monitor/panel.css";
		/** Routes served by the server half. */
		const SNAPSHOT_URL = "/api/cpa-monitor/snapshot";
		const REFRESH_URL = "/api/cpa-monitor/refresh";
		/** Failed-request diagnostics: list, then one log by name. */
		const DIAGNOSTICS_URL = "/api/cpa-monitor/diagnostics";
		/** Banked reset credits for one credential, fetched on demand. */
		const CREDITS_URL = "/api/cpa-monitor/credits";
		/** Credential writes (enable/disable, note, priority). */
		const ACCOUNT_URL = "/api/cpa-monitor/account";
		/** Header a state-changing request must carry (see the server half's CSRF note). */
		const ACTION_HEADER = "x-dsh-cpa-monitor-action";
		/** Badge refresh cadence; the server serves its cache, so this is cheap. */
		const POLL_MS = 60000;
		/** Countdown re-render cadence. */
		const TICK_MS = 30000;
		/**
		 * Below this, a short (5h) window is what the badge reports. A session hits
		 * the short window first, so it is the one worth surfacing; above it the
		 * long window (7d/30d) is the real story.
		 */
		const BADGE_SHORT_THRESHOLD = 20;
		//#endregion

		//#region css
		const css = [
			".cps_layer{flex:none;align-items:center;width:100%;height:49px;margin:8px 0 0;display:flex;position:relative}",
			".cps_badge{width:100%;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}",
			".cps_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".cps_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}",
			".cps_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			// The percentage sits directly after the label, exactly like the balance in
			// the usage row beside it; only the account count is pushed to the far edge.
			".cps_badgeAmount{font-variant-numeric:tabular-nums;flex:none;font-size:12px;font-weight:600;line-height:16px}",
			".cps_badgeCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
			".cps_ok{color:var(--dsw-alias-state-success-primary)}",
			".cps_warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}",
			".cps_bad{color:var(--dsw-alias-state-error-primary)}",
			".cps_muted{color:var(--dsw-alias-label-tertiary)}",
			".cps_dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}",
			".cps_layer.cps_rail{width:36px;height:36px;margin:0}",
			".cps_layer.cps_rail .cps_badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}",
			".cps_panel{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));width:430px;max-width:calc(100vw - 24px);max-height:74vh;box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;display:flex;position:fixed;bottom:118px;left:12px;overflow:hidden}",
			".cps_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex;gap:8px}",
			".cps_headerLeft{min-width:0;align-items:center;gap:8px;display:flex}",
			".cps_title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}",
			".cps_subtitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".cps_headerActions{align-items:center;gap:2px;display:flex;flex:none}",
			".cps_iconButton{cursor:pointer;min-width:26px;height:26px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;padding:0 5px;font-size:12px;line-height:1;white-space:nowrap;display:inline-flex}",
			".cps_iconButton:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".cps_iconButton[disabled]{cursor:default;opacity:.5}",
			".cps_spin{animation:cps_spin 1s linear infinite}",
			"@keyframes cps_spin{to{transform:rotate(360deg)}}",
			".cps_body{flex:1;min-height:0;padding:10px 12px 12px;overflow-y:auto}",
			".cps_summary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1,transparent);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;margin-bottom:10px}",
			".cps_summaryRow{align-items:baseline;gap:8px;display:flex}",
			".cps_summaryValue{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}",
			".cps_summaryLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".cps_summaryMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:flex;flex-wrap:wrap;gap:10px}",
			".cps_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 10px;display:flex;flex-direction:column;gap:7px;margin-bottom:8px}",
			".cps_card:last-child{margin-bottom:0}",
			".cps_card[data-tone=bad]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2))}",
			".cps_card[data-tone=warn]{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary)) 45%,var(--dsw-alias-border-l2))}",
			".cps_card[data-dimmed]{opacity:.62}",
			".cps_cardHead{align-items:center;gap:8px;display:flex}",
			".cps_cardIdentity{min-width:0;flex:1;display:flex;flex-direction:column}",
			".cps_cardName{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;line-height:17px;overflow:hidden}",
			".cps_cardPlan{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}",
			".cps_chip{border-radius:999px;padding:2px 7px;font-size:10px;line-height:15px;white-space:nowrap;flex:none;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-tertiary)}",
			".cps_chip[data-tone=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}",
			".cps_chip[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));background:var(--dsw-alias-fill-l2)}",
			".cps_chip[data-tone=bad]{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}",
			".cps_window{display:flex;flex-direction:column;gap:3px}",
			".cps_windowHead{align-items:baseline;gap:8px;font-size:11px;line-height:16px;display:flex}",
			".cps_windowLabel{color:var(--dsw-alias-label-secondary);flex:none;font-weight:600;min-width:26px}",
			".cps_windowReset{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".cps_windowValue{color:var(--dsw-alias-label-primary);margin-left:auto;flex:none;font-variant-numeric:tabular-nums;font-weight:600}",
			".cps_track{background:var(--dsw-alias-fill-l2);border-radius:999px;height:6px;overflow:hidden}",
			".cps_fill{height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary)}",
			".cps_fill[data-tone=warn]{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}",
			".cps_fill[data-tone=bad]{background:var(--dsw-alias-state-error-primary)}",
			".cps_cardMeta{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:10px;font-size:10px;line-height:15px;font-variant-numeric:tabular-nums;display:flex}",
			".cps_spark{align-items:flex-end;gap:1px;height:22px;display:flex}",
			".cps_sparkBucket{background:var(--dsw-alias-state-success-primary);border-radius:1px;flex:1;min-width:1px;min-height:1px;opacity:.75;display:flex;flex-direction:column;justify-content:flex-end}",
			".cps_sparkFail{background:var(--dsw-alias-state-error-primary)}",
			".cps_cardError{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:7px;padding:5px 7px;font-size:11px;line-height:16px;word-break:break-word}",
			".cps_alert{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;padding:7px 8px;font-size:12px;line-height:18px;display:flex;margin-bottom:10px}",
			".cps_alertText{min-width:0;word-break:break-word}",
			".cps_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;text-decoration:underline}",
			".cps_note{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));margin-top:10px;font-size:10px;line-height:15px;word-break:break-word}",
			".cps_cardAction{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:11px;line-height:15px;flex:none}",
			".cps_cardAction:hover:not([disabled]){color:var(--dsw-alias-label-primary)}",
			".cps_cardAction[disabled]{cursor:default;opacity:.5}",
			".cps_cardNote{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;word-break:break-word}",
			".cps_cardEditor{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px}",
			".cps_editorField{flex-direction:column;gap:3px;display:flex}",
			".cps_editorActions{justify-content:flex-end;align-items:center;gap:8px;display:flex}",
			".cps_editorSpacer{flex:1}",
			".cps_inputSm{height:28px;font-size:12px}",
			".cps_diagRow{align-items:center;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1);padding:6px 0;display:flex}",
			".cps_diagItem:first-child>.cps_diagRow{border-top:0}",
			".cps_diagDetail{padding-bottom:8px}",
			".cps_diagTime{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}",
			".cps_diagMain{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}",
			".cps_diagStatus{flex:none;font-size:11px;font-weight:600;line-height:15px;font-variant-numeric:tabular-nums}",
			".cps_diagMessage{color:var(--dsw-alias-label-primary);font-size:11px;line-height:15px;word-break:break-word}",
			".cps_diagMeta{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:8px;font-size:10px;line-height:15px;display:flex}",
			".cps_diagText{background:var(--dsw-alias-fill-l1,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);max-height:240px;margin-top:6px;padding:8px;font-family:var(--ds-font-family-code,monospace);font-size:10px;line-height:15px;white-space:pre-wrap;word-break:break-word;overflow:auto}",
			".cps_section{margin-top:12px}",
			".cps_empty{color:var(--dsw-alias-label-tertiary);padding:14px 0;text-align:center;font-size:12px;line-height:18px}",
			// No color of its own: the icon inherits the row's neutral label color, so
			// it reads like every other sidebar glyph whatever the quota state.
			".cps_iconWrap{flex:none;width:16px;height:16px;justify-content:center;align-items:center;display:inline-flex}",
			// settings card — mirrors the card chrome the shipped Plugins section
			// renders, so a third-party card is visually indistinguishable from it:
			// same .5px border-l4 shell on bg-layer-3, bg-layer-2 once open, an 18px
			// heading over a 13px description, a chevron that rotates, and a body
			// inset by the header's own 16px padding.
			".cps_set{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}",
			".cps_set[data-open]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".cps_setHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".cps_setHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			// 15px/600 — the shipped Plugins cards use their `name` token here, not the
			// 18px section heading that sits above the list.
			".cps_setTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".cps_setDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
			".cps_setPending{flex:none}",
			".cps_setReadOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
			".cps_setChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:inline-flex}",
			".cps_setChevron[data-open]{transform:rotate(180deg)}",
			".cps_setBody{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
			".cps_setInline{padding:0}",
			".cps_setInlineHead{color:var(--dsw-alias-label-secondary);margin:0 0 8px;font-size:12px;line-height:1.5}",
			".cps_setPageBody{padding-bottom:4px}",
			".cps_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
			".cps_field+.cps_field{border-top:.5px solid var(--dsw-alias-border-l2)}",
			".cps_fieldHead{align-items:center;gap:8px;display:flex}",
			".cps_fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
			".cps_fieldBadges{align-items:center;gap:8px;display:inline-flex}",
			".cps_fieldBadge{color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:12px;line-height:1.5;flex:none}",
			".cps_fieldClear{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5;flex:none}",
			".cps_fieldClear:hover:not([disabled]){color:var(--dsw-alias-label-primary)}",
			".cps_fieldClear[disabled]{cursor:default}",
			".cps_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);box-sizing:border-box;width:100%;height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}",
			".cps_input:focus{border-color:var(--dsw-alias-label-dimmed);outline:none}",
			".cps_input[data-invalid]{border-color:var(--dsw-alias-label-error)}",
			".cps_input:disabled{opacity:.6}",
			".cps_select{cursor:pointer}",
			".cps_textarea{height:auto;min-height:66px;padding:8px 12px;resize:vertical;font-family:var(--ds-font-family-code,monospace)}",
			".cps_checkRow{align-items:center;gap:8px;display:flex}",
			".cps_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".cps_hintBad{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}",
			".cps_setFoot{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".cps_setNote{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".cps_setFailed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".cps_setBtn{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;flex:none}",
			".cps_setBtn:disabled{cursor:default;opacity:.55}",
			".cps_setBtnQuiet{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
			".cps_setBtnQuiet:hover:not([disabled]){color:var(--dsw-alias-label-primary)}",
			".cps_setBtnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".cps_setBtnPrimary:hover:not([disabled]){opacity:.88}",
			".cps_setBtnDanger{background:var(--dsw-alias-label-error);color:var(--dsw-alias-bg-layer-3)}",
			".cps_setBtnDanger:hover:not([disabled]){opacity:.88}",
			".cps_creditLink{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;padding:0;font-size:11px;line-height:15px;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}",
			".cps_creditLink:hover{color:var(--dsw-alias-label-primary)}",
			".cps_creditPanel{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:6px;padding:8px;display:flex;flex-direction:column;gap:6px}",
			".cps_creditHead{color:var(--dsw-alias-label-secondary);justify-content:space-between;gap:8px;font-size:11px;line-height:15px;display:flex}",
			".cps_creditList{margin:0;padding-left:16px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".cps_creditWarn{color:var(--dsw-alias-label-error);margin:0;font-size:11px;line-height:16px}",
			".cps_creditActions{justify-content:flex-end;gap:8px;display:flex}"
		].join("");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cpa-monitor";
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region helpers
		/** Byte size as a short human string. */
		function sizeText(bytes) {
			if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
			if (bytes < 1024) return `${String(bytes)} B`;
			if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
			return `${String(Math.round(bytes / 1024 / 1024))} MB`;
		}

		/**
		 * One account's priority as draft text.
		 *
		 * Blank covers both `null` and `undefined`: a server half older than the
		 * priority field reports neither, and `String(undefined)` would otherwise
		 * put the literal text "undefined" in the control.
		 *
		 * @param account - an account from the snapshot.
		 * @returns the draft text, empty when CPA reported no priority.
		 */
		function priorityTextOf(account) {
			return typeof account?.priority === "number" && Number.isFinite(account.priority) ? String(account.priority) : "";
		}

		/** A timestamp as the same `MM/DD HH:MM` shape the rest of the panel uses. */
		function stampText(at) {
			if (typeof at !== "number" || !Number.isFinite(at)) return "—";
			const date = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** Keys a reset-credit record has carried an expiry under, in the wild. */
		const CREDIT_EXPIRY_KEYS = [
			"expires_at",
			"expiresAt",
			"expires_on",
			"expiresOn",
			"expire_at",
			"expireAt",
			"expiry",
			"expires",
			"expiration",
			"valid_until",
			"validUntil",
			"reset_at",
			"resetAt"
		];

		/** Read one record's expiry as an epoch instant, tolerating seconds and strings. */
		function creditInstant(record) {
			for (const key of CREDIT_EXPIRY_KEYS) {
				const value = record?.[key];
				if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
				if (typeof value === "string" && value !== "") {
					const parsed = Date.parse(value);
					if (Number.isFinite(parsed)) return parsed;
				}
			}
			return null;
		}

		/**
		 * Read the individual reset credits out of CPA's `rate_limit_reset_credits`.
		 *
		 * That payload is shaped by the upstream subscription API rather than by
		 * CPA's own management contract, so this stays deliberately tolerant: the
		 * count comes from the field the card already showed, and any array of
		 * records under a plausible name contributes one row per entry. An expiry
		 * this cannot read is reported as unknown — never invented — because the
		 * whole point of showing it is to warn before a scarce credit lapses.
		 *
		 * @param detail - the raw `rate_limit_reset_credits` object, or null.
		 * @returns one `{ expiresAt }` per credit; an empty array when there is
		 * nothing to list.
		 */
		function resetCreditEntries(detail) {
			if (detail === null || typeof detail !== "object") return [];
			const list = ["credits", "items", "available", "list", "entries"].map((key) => detail[key]).find(Array.isArray);
			if (list !== undefined) {
				return list.map((entry) => ({ expiresAt: creditInstant(entry !== null && typeof entry === "object" ? entry : {}) }));
			}
			const single = creditInstant(detail);
			return single === null ? [] : [{ expiresAt: single }];
		}

		/** Fill `{name}` placeholders in a translated string. */
		function interpolate(text, params) {
			if (text === undefined || text === null) return "";
			if (params === undefined) return String(text);
			return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		/** Same-origin JSON fetch; a non-2xx response still resolves so we can read its `error`. */
		async function fetchJson(url, init) {
			const response = await fetch(url, { credentials: "same-origin", ...init });
			try {
				return await response.json();
			} catch {
				// A 2xx that is not JSON is the shell's SPA fallback answering a route
				// this server half does not serve yet — say so instead of "HTTP 200".
				return {
					ok: false,
					error: response.ok ? `${url} is not served by this server half (restart dsh web?)` : `HTTP ${String(response.status)}`
				};
			}
		}

		/** Progress-bar tone from the remaining percentage. */
		function toneOfRemaining(remaining) {
			if (typeof remaining !== "number") return "muted";
			if (remaining <= 10) return "bad";
			if (remaining <= 30) return "warn";
			return "ok";
		}

		/** Compact remaining-seconds text, e.g. `2h31m` / `42s`. */
		function durationText(seconds) {
			if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
			if (seconds < 60) return `${String(Math.round(seconds))}s`;
			if (seconds < 3600) return `${String(Math.round(seconds / 60))}m`;
			if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h${String(Math.round((seconds % 3600) / 60))}m`;
			return `${String(Math.floor(seconds / 86400))}d${String(Math.round((seconds % 86400) / 3600))}h`;
		}

		/**
		 * Live reset line for a window: absolute stamp plus a countdown.
		 * @param window - the window model.
		 * @param now - current epoch milliseconds.
		 * @param later - localized "left" suffix.
		 * @returns the display text.
		 */
		function resetText(window, now, later = "后") {
			const parts = [];
			if (window.resetText !== null && window.resetText !== undefined) parts.push(window.resetText);
			const target = window.resetAt === null || window.resetAt === undefined ? null : window.resetAt * 1000;
			if (target !== null) {
				const left = (target - now) / 1000;
				if (left > 0) parts.push(`(${durationText(left)} ${later})`);
			}
			return parts.join(" ");
		}

		/** Wall-clock stamp for the panel subtitle. */
		function clockText(ts) {
			if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
			const date = new Date(ts);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/**
		 * Choose the account the sidebar badge reports.
		 *
		 * The badge shows that account's short and long remainings as `5h%/7d%`
		 * (the same shape the reference Python collector publishes), so the rules
		 * below are about WHICH account is worth the headline:
		 *
		 *   1. an account whose short (5h) window is below
		 *      {@link BADGE_SHORT_THRESHOLD} wins outright — that is the window a
		 *      session exhausts next, and the lowest one wins;
		 *   2. otherwise the account with the tightest long (7d / 30d) window wins,
		 *      so a fleet of comfortable 5h windows cannot hide a long window
		 *      running out;
		 *   3. an account reporting only a comfortable short window still supplies
		 *      the headline rather than leaving the badge empty.
		 *
		 * Accounts CPA has disabled are ignored throughout: they cannot serve a
		 * request, so their quota is not what the badge should warn about.
		 *
		 * @param snapshot - a snapshot from the server half.
		 * @returns the chosen account, the deciding value, and which rule fired.
		 */
		function pickBadge(snapshot) {
			if (snapshot === null || snapshot === undefined) return null;
			const value = (window) =>
				window !== null && window !== undefined && typeof window.remaining === "number" && Number.isFinite(window.remaining)
					? window.remaining
					: null;
			const enabled = (snapshot.accounts ?? []).filter((account) => account.disabled !== true);
			const ranked = (read) =>
				enabled
					.map((account) => ({ account, value: read(account) }))
					.filter((entry) => entry.value !== null)
					.sort((left, right) => left.value - right.value);
			const urgent = ranked((account) => (account.short?.label === "5h" ? value(account.short) : null)).filter(
				(entry) => entry.value < BADGE_SHORT_THRESHOLD
			);
			if (urgent.length > 0) return { ...urgent[0], reason: "short" };
			const longs = ranked((account) => value(account.long));
			if (longs.length > 0) return { ...longs[0], reason: "long" };
			const shorts = ranked((account) => value(account.short));
			if (shorts.length > 0) return { ...shorts[0], reason: "fallback" };
			return null;
		}

		/** The window labels the badge reports, in display order. */
		const BADGE_WINDOWS = ["5h", "7d", "30d"];

		/**
		 * One account's remaining percentage for a window label.
		 * @param account - an account from the snapshot.
		 * @param label - `5h`, `7d`, or `30d`.
		 * @returns the percentage, or null when the account has no such window.
		 */
		function windowRemaining(account, label) {
			const window = (account?.windows ?? []).find((entry) => entry.label === label);
			return typeof window?.remaining === "number" && Number.isFinite(window.remaining) ? window.remaining : null;
		}

		/**
		 * Sum one window's remaining percentages across accounts.
		 *
		 * The pool's headroom, not a percentage of anything: three accounts at 100%
		 * report 300%, because each account carries its own full quota. Disabled
		 * accounts are excluded — they cannot serve, so they contribute no headroom.
		 *
		 * @param accounts - the snapshot's accounts.
		 * @param label - `5h`, `7d`, or `30d`.
		 * @returns the sum, or null when no account reports that window.
		 */
		function sumRemaining(accounts, label) {
			const values = (accounts ?? [])
				.filter((account) => account.disabled !== true)
				.map((account) => windowRemaining(account, label))
				.filter((value) => value !== null);
			return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
		}

		/**
		 * Render the badge's `5h/7d[/30d]` text.
		 *
		 * A missing short or long window shows as `-`; the 30d segment is dropped
		 * entirely when nothing reports it, so an all-7d pool reads `94%/12%`.
		 *
		 * @param values - remaining percentages keyed by window label.
		 * @returns the display text.
		 */
		function remainingText(values) {
			const percent = (value) => (typeof value === "number" && Number.isFinite(value) ? `${String(Math.round(value))}%` : "-");
			const head = `${percent(values["5h"])}/${percent(values["7d"])}`;
			return values["30d"] === null || values["30d"] === undefined ? head : `${head}/${percent(values["30d"])}`;
		}

		/**
		 * Resolve the remaining percentages the badge should show.
		 * @param snapshot - a snapshot from the server half.
		 * @param mode - `lowest` (the chosen account) or `total` (per-window sum).
		 * @returns remaining percentages keyed by window label.
		 */
		function badgeValues(snapshot, mode) {
			const accounts = snapshot?.accounts ?? [];
			const read = mode === "total" ? (label) => sumRemaining(accounts, label) : (label) => windowRemaining(pickBadge(snapshot)?.account, label);
			return Object.fromEntries(BADGE_WINDOWS.map((label) => [label, read(label)]));
		}

		/** The account's worst window, which decides its card tone. */
		function worstOf(account) {
			if (account.disabled) return null;
			if (account.error !== null && account.error !== undefined) return "bad";
			if (account.limitReached) return "bad";
			if (typeof account.minRemaining !== "number") return null;
			return toneOfRemaining(account.minRemaining);
		}

		/** Whether a pointer event landed outside both the badge and the portaled panel. */
		function shouldDismissPanel(path, target, layer, panel) {
			const eventPath = Array.isArray(path) ? path : [];
			const inside = (root) =>
				root !== null && root !== undefined && (eventPath.includes(root) || (target && typeof root.contains === "function" && root.contains(target)));
			return !inside(layer) && !inside(panel);
		}

		/**
		 * Let several footer actions share the row by wrapping instead of squeezing.
		 * Idempotent, and restored on unmount.
		 */
		function enableFooterActionWrapping(host) {
			const style = window.getComputedStyle(host);
			if (!style.display.includes("flex") || style.flexDirection.startsWith("column") || style.flexWrap !== "nowrap") return undefined;
			const previous = host.style.flexWrap;
			host.style.flexWrap = "wrap";
			return () => {
				host.style.flexWrap = previous;
			};
		}

		/**
		 * The shell's Tag, which is what the shipped cards use for the "unsaved"
		 * marker; falls back to a plain span so a build without it degrades to text
		 * rather than crashing the card.
		 * @param props - the badge text.
		 */
		function StateTag({ children }) {
			const component = primitives.Tag;
			if (typeof component === "function" || typeof component === "object") {
				return h(component, { tone: "neutral", className: "cps_setPending" }, children);
			}
			return h("span", { className: "cps_setPending" }, children);
		}

		/**
		 * Render a shell icon, tolerating the icon-name change between hosts.
		 *
		 * DSH ≤ 0.1 exports size-suffixed names (`IconRefreshOutline16`,
		 * `IconChevronDownOutline14`); DSH ≥ 0.2 exports variant-suffixed ones
		 * (`IconRefreshOutlineRegular`, plus `…Medium` / `…Artwork`) and takes the
		 * size as a prop. Each call site therefore lists its candidates in
		 * preference order and the first name the shell actually exports wins —
		 * asking for the legacy name alone silently degraded the refresh control to
		 * its text fallback on 0.2.
		 *
		 * @param names - one shell export name, or candidates tried in order.
		 * @param props - props for the icon component.
		 * @returns the icon element, or null when the shell exports none of them.
		 */
		function Icon(names, props) {
			for (const name of Array.isArray(names) ? names : [names]) {
				const component = primitives[name];
				if (typeof component === "function" || (typeof component === "object" && component !== null)) return h(component, props);
			}
			return null;
		}
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"badge.label": "CPA 账号",
			"badge.tip": "CPA 账号状态",
			"badge.tipAccount": "用量最低的账号 {account}：{value}",
			"badge.tipTotal": "各账号按窗口累加：{value}",
			"panel.title": "CPA 账号状态",
			"panel.subtitle": "更新于 {time} · {endpoint}",
			"panel.subtitlePending": "尚未取到数据",
			"action.refresh": "刷新",
			"action.close": "关闭",
			"action.retry": "重试",
			"summary.tightest": "最紧账号",
			"summary.totalHint": "各账号按窗口累加，不含已禁用账号",
			"summary.mode.lowest": "用量最低",
			"summary.mode.total": "账号累加",
			"summary.accounts": "{active}/{total} 可用",
			"summary.attention": "{count} 个待处理",
			"summary.disabled": "{count} 个已禁用",
			"summary.empty": "未发现 {provider} 账号",
			"status.active": "正常",
			"status.error": "异常",
			"status.disabled": "已禁用",
			"status.unavailable": "不可用",
			"status.unknown": "未知",
			"card.reset": "重置",
			"card.success": "成功 {count}",
			"card.failed": "失败 {count}",
			"card.resetCredits": "重置券 {count}",
			"credits.title": "重置券",
			"credits.available": "可用 {count} 张",
			"credits.expires": "到期 {time}",
			"credits.expiryUnknown": "到期时间未提供",
			"credits.none": "没有可用的重置券。",
			"credits.hint": "重置会清除该账号的配额与冷却状态，并消耗 1 张重置券（不可撤销）。",
			"credits.action": "重置",
			"credits.confirm": "确认重置？这会消耗 1 张重置券，且无法撤销。",
			"credits.confirmYes": "确认重置",
			"credits.cancel": "取消",
			"credits.working": "重置中…",
			"credits.done": "已重置",
			"credits.readOnly": "当前设置为只读，无法执行重置。",
			"credits.loading": "读取中…",
			"credits.loadFailed": "读取到期信息失败：{error}",
			"credits.redeemed": "已于 {time} 兑换",
			"credits.refresh": "刷新 OAuth 凭证",
			"credits.refreshing": "刷新中…",
			"credits.refreshed": "已刷新",
			"credits.refreshHint": "让 CPA 立刻用 refresh token 换一张新的 access token。需要 CPA v8 的接口。",
			"card.noWindow": "无速率窗口数据",
			"card.limitReached": "已达上限",
			"card.later": "后",
			"note.countdown": "剩余百分比为「重置前可用量」；进度条越短越危险。",
			"error.noTransport": "无法连接 CPA，请检查代理设置。",
			"card.enable": "启用",
			"card.disable": "禁用",
			"card.edit": "编辑",
			"card.editNote": "备注",
			"card.editPriority": "优先级",
			"card.editHint": "优先级只在 CPA 按优先级调度时起作用；留空表示不修改。",
			"card.editPriorityHint": "数字越小越优先（按 CPA 当前策略）。留空表示不修改。",
			"card.save": "保存",
			"card.cancel": "取消",
			"card.pending": "写入中…",
			"card.priority": "优先级 {value}",
			"diag.title": "最近失败请求",
			"diag.show": "查看",
			"diag.hide": "收起",
			"diag.loading": "读取中…",
			"diag.empty": "没有失败记录。",
			"diag.requestLogOn": "CPA 已开启 request-log，失败记录并入请求日志目录，这里读不到——请去 CPA 的日志页查看。",
			"diag.attempts": "{count} 次尝试",
			"diag.open": "详情",
			"diag.noMessage": "未解析出错误信息",
			"diag.accounts": "涉及账号",
			"diag.truncated": "（已截断）",
			"version.label": "CPA {version}",
			"version.update": "有新版本 {latest}",
			"version.unknown": "CPA 版本未知",
			"stale.title": "服务端 half 是旧版",
			"stale.body": "账号开关、失败诊断与版本信息需要重启 dsh web 才会生效（浏览器这一半已热重载）。",
			"card.staleWrite": "服务端 half 是旧版，写操作不可用：请重启 dsh web。",
			"settings.title": "CPA 账号状态",
			"settings.description": "配置 CLIProxyAPI 管理口地址、出网代理与轮询周期。保存后立即生效，无需重启。",
			"settings.state.invalid": "有字段填写不正确",
			"settings.unsaved": "未保存",
			"settings.expand": "展开",
			"settings.collapse": "收起",
			"settings.readOnly": "当前设置为只读（连接为进程内模式）",
			"settings.overridden": "已覆盖",
			"settings.clear": "清除",
			"settings.action.save": "保存",
			"settings.action.discard": "放弃",
			"settings.action.resetAll": "全部恢复默认",
			"settings.secretPlaceholder": "留空表示不修改",
			"settings.boolOn": "开启",
			"settings.boolOff": "关闭",
			"settings.baseURL": "CPA 地址",
			"settings.baseURL.hint": "CLIProxyAPI 管理口，例如 https://cpa.example.com:8317",
			"settings.managementKey": "管理密钥",
			"settings.managementKey.hint": "请求头 Authorization: Bearer <密钥>。留空则回退读环境变量 DSH_CPA_MANAGEMENT_KEY。",
			"settings.proxies": "代理地址",
			"settings.proxies.hint": "每行一个，按顺序尝试；支持 http:// / https:// / socks5://，也可直接写 host:port（按 HTTP 代理处理）。留空表示直连。",
			"settings.allowDirect": "允许直连",
			"settings.allowDirect.hint": "所有代理都失败后再尝试直连；代理列表为空时自动直连。",
			"settings.refreshIntervalMs": "轮询周期（秒）",
			"settings.refreshIntervalMs.hint": "后台拉取间隔，最小 5 秒。",
			"settings.timeoutMs": "请求超时（秒）",
			"settings.timeoutMs.hint": "单个上游请求的端到端上限。",
			"settings.connectTimeoutMs": "连接超时（秒）",
			"settings.connectTimeoutMs.hint": "单条代理握手/TLS 的上限，不能大于请求超时。",
			"settings.providerFilter": "Provider 过滤",
			"settings.providerFilter.hint": "只监控该 provider 的凭据，留空表示全部。",
			"settings.includeDisabled": "包含已禁用账号",
			"settings.includeDisabled.hint": "把 CPA 里已禁用的账号一并列出（置灰显示）。",
			"settings.badgeMode": "侧栏徽标口径",
			"settings.badgeMode.hint": "「用量最低的账号」只报最紧张那个账号的 5h/7d/30d 余量；「各账号累加」把各账号的余量按窗口相加（三个账号各 100% 就是 300%）。对应配置值分别为 lowest 与 total。颜色跟着屏幕上这个数走——账号池会负载均衡，单个账号见底不拖累整体。",
			"settings.badgeMode.lowest": "用量最低的账号",
			"settings.badgeMode.total": "各账号累加",
			"settings.timeZone": "时区",
			"settings.timeZone.hint": "重置时间的显示时区，例如 Asia/Shanghai。",
			"settings.insecure": "跳过证书校验",
			"settings.insecure.hint": "仅用于 CPA 使用自签名证书的情况。",
			"settings.footNote": "保存后立即生效，写入当前 profile 的配置层。",
			"settings.writeFailed": "保存失败：宿主拒绝了这次写入，已重新读取磁盘上的当前值。",
			"settings.formMissing": "宿主还没有提供这一行的配置表单。若刚更新过服务端半边，重启 dsh 后再看；重启后依旧如此，说明宿主没能把服务端的 schema 投影成表单。",
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"badge.label": "CPA accounts",
			"badge.tip": "CPA account status",
			"badge.tipAccount": "Lowest account {account}: {value}",
			"badge.tipTotal": "Summed across accounts: {value}",
			"panel.title": "CPA account status",
			"panel.subtitle": "Updated {time} · {endpoint}",
			"panel.subtitlePending": "No data yet",
			"action.refresh": "Refresh",
			"action.close": "Close",
			"action.retry": "Retry",
			"summary.tightest": "Tightest account",
			"summary.totalHint": "Summed per window across enabled accounts",
			"summary.mode.lowest": "Lowest account",
			"summary.mode.total": "Pool total",
			"summary.accounts": "{active}/{total} usable",
			"summary.attention": "{count} need attention",
			"summary.disabled": "{count} disabled",
			"summary.empty": "No {provider} account found",
			"status.active": "Active",
			"status.error": "Error",
			"status.disabled": "Disabled",
			"status.unavailable": "Unavailable",
			"status.unknown": "Unknown",
			"card.reset": "Resets",
			"card.success": "{count} ok",
			"card.failed": "{count} failed",
			"card.resetCredits": "{count} reset credits",
			"credits.title": "Reset credits",
			"credits.available": "{count} available",
			"credits.expires": "expires {time}",
			"credits.expiryUnknown": "expiry not reported",
			"credits.none": "No reset credit available.",
			"credits.hint": "Resetting clears this account's quota and cooldown state and spends one reset credit. It cannot be undone.",
			"credits.action": "Reset",
			"credits.confirm": "Reset now? This spends one reset credit and cannot be undone.",
			"credits.confirmYes": "Reset now",
			"credits.cancel": "Cancel",
			"credits.working": "Resetting…",
			"credits.done": "Reset",
			"credits.readOnly": "This configuration is read-only, so a reset cannot be performed.",
			"credits.loading": "Reading…",
			"credits.loadFailed": "Could not read the expiry: {error}",
			"credits.redeemed": "redeemed {time}",
			"credits.refresh": "Refresh OAuth credential",
			"credits.refreshing": "Refreshing…",
			"credits.refreshed": "Refreshed",
			"credits.refreshHint": "Ask CPA to exchange the refresh token for a new access token right now. Requires the CPA v8 API.",
			"card.noWindow": "No rate-limit window reported",
			"card.limitReached": "Limit reached",
			"card.later": "left",
			"note.countdown": "The percentage is the quota still available before reset; a shorter bar is worse.",
			"error.noTransport": "Cannot reach CPA — check the proxy settings.",
			"card.enable": "Enable",
			"card.disable": "Disable",
			"card.edit": "Edit",
			"card.editNote": "Note",
			"card.editPriority": "Priority",
			"card.editHint": "Priority only matters while CPA routes by priority; leave blank to keep it.",
			"card.editPriorityHint": "Lower wins under CPA's priority routing; leave blank to keep it.",
			"card.save": "Save",
			"card.cancel": "Cancel",
			"card.pending": "Writing…",
			"card.priority": "priority {value}",
			"diag.title": "Recent failures",
			"diag.show": "Show",
			"diag.hide": "Hide",
			"diag.loading": "Loading…",
			"diag.empty": "No failed request recorded.",
			"diag.requestLogOn": "CPA has request-log enabled, so failures go to the request-log directory instead — read them from CPA's own log page.",
			"diag.attempts": "{count} attempts",
			"diag.open": "Details",
			"diag.noMessage": "No error message parsed",
			"diag.accounts": "Accounts",
			"diag.truncated": "(truncated)",
			"version.label": "CPA {version}",
			"version.update": "update {latest}",
			"version.unknown": "CPA version unknown",
			"stale.title": "The server half is older than this browser half",
			"stale.body": "Account controls, failure diagnostics, and the version chip need a dsh web restart; only the browser half was hot-reloaded.",
			"card.staleWrite": "The server half is older: restart dsh web to enable writes.",
			"settings.title": "CPA account status",
			"settings.description": "Manage the CLIProxyAPI endpoint, the outbound proxies, and the poll period. Changes apply immediately, with no restart.",
			"settings.state.invalid": "A field is not valid",
			"settings.unsaved": "Unsaved",
			"settings.expand": "Expand",
			"settings.collapse": "Collapse",
			"settings.readOnly": "These settings are read-only (the connection is process-local)",
			"settings.overridden": "Overridden",
			"settings.clear": "Clear",
			"settings.action.save": "Save",
			"settings.action.discard": "Discard",
			"settings.action.resetAll": "Reset all",
			"settings.secretPlaceholder": "Leave blank to keep the stored key",
			"settings.boolOn": "On",
			"settings.boolOff": "Off",
			"settings.baseURL": "CPA address",
			"settings.baseURL.hint": "The CLIProxyAPI management endpoint, e.g. https://cpa.example.com:8317",
			"settings.managementKey": "Management key",
			"settings.managementKey.hint": "Sent as Authorization: Bearer <key>. Leave blank to read DSH_CPA_MANAGEMENT_KEY from the environment instead.",
			"settings.proxies": "Proxy addresses",
			"settings.proxies.hint": "One per line, tried in order; http://, https://, and socks5:// are supported, as is a bare host:port (treated as an HTTP proxy). Empty means connect directly.",
			"settings.allowDirect": "Allow direct connection",
			"settings.allowDirect.hint": "Try a direct connection once every proxy has failed. Implicit when the proxy list is empty.",
			"settings.refreshIntervalMs": "Poll period (seconds)",
			"settings.refreshIntervalMs.hint": "Background refresh interval, at least 5 seconds.",
			"settings.timeoutMs": "Request timeout (seconds)",
			"settings.timeoutMs.hint": "End-to-end limit for one upstream request.",
			"settings.connectTimeoutMs": "Connect timeout (seconds)",
			"settings.connectTimeoutMs.hint": "Limit for one proxy handshake or TLS leg; must not exceed the request timeout.",
			"settings.providerFilter": "Provider filter",
			"settings.providerFilter.hint": "Monitor only this CPA credential provider; empty means all of them.",
			"settings.includeDisabled": "Include disabled accounts",
			"settings.includeDisabled.hint": "List accounts disabled in CPA too, greyed out.",
			"settings.badgeMode": "Badge figure",
			"settings.badgeMode.hint": "'Lowest account' reports just the most critical account's 5h/7d/30d; 'Summed across accounts' adds each window over the pool (three accounts at 100% report 300%). The stored values are lowest and total. The colour follows the figure on screen — a pool load-balances, so one exhausted account does not drag the aggregate down.",
			"settings.badgeMode.lowest": "Lowest account",
			"settings.badgeMode.total": "Summed across accounts",
			"settings.timeZone": "Time zone",
			"settings.timeZone.hint": "Zone used to render reset times, e.g. Asia/Shanghai.",
			"settings.insecure": "Skip certificate checks",
			"settings.insecure.hint": "Only for a CPA behind a self-signed certificate.",
			"settings.footNote": "Applies immediately; stored in the current profile's configuration layer.",
			"settings.writeFailed": "Save failed: the host refused this write and has re-read the values on disk.",
			"settings.formMissing": "The host has not supplied a configuration form for this row yet. Restart dsh if the server half was just updated; if it persists, the host could not project the server\u2019s schema into a form.",
		};
		//#endregion

		//#region components
		/**
		 * One rate-limit window: label, reset time with countdown, bar, and value.
		 * @param props - the window model, the clock, and the translator.
		 */
		function WindowRow({ window, now, tr }) {
			const tone = toneOfRemaining(window.remaining);
			const percent = typeof window.remaining === "number" ? `${String(Math.round(window.remaining))}%` : "—";
			return h("div", { className: "cps_window" }, [
				h("div", { className: "cps_windowHead", key: "head" }, [
					h("span", { className: "cps_windowLabel", key: "label" }, window.label),
					h("span", { className: "cps_windowReset", key: "reset" }, `${tr("card.reset")} ${resetText(window, now, tr("card.later"))}`.trim()),
					h("span", { className: "cps_windowValue", key: "value" }, percent)
				]),
				h(
					"div",
					{ className: "cps_track", key: "track" },
					h("div", {
						className: "cps_fill",
						"data-tone": tone,
						style: { width: `${String(Math.max(0, Math.min(100, typeof window.remaining === "number" ? window.remaining : 0)))}%` }
					})
				)
			]);
		}

		/** Twenty 10-minute buckets of upstream success/failure counts. */
		function Sparkline({ buckets }) {
			if (!Array.isArray(buckets) || buckets.length === 0) return null;
			const max = buckets.reduce((peak, bucket) => Math.max(peak, (bucket.success ?? 0) + (bucket.failed ?? 0)), 0);
			return h(
				"div",
				{ className: "cps_spark" },
				buckets.map((bucket, index) => {
					const total = (bucket.success ?? 0) + (bucket.failed ?? 0);
					const height = max === 0 ? 0 : Math.round((total / max) * 22);
					const failHeight = max === 0 ? 0 : Math.round(((bucket.failed ?? 0) / max) * 22);
					return h(
						"div",
						{
							className: "cps_sparkBucket",
							key: `${String(index)}-${bucket.time ?? ""}`,
							title: `${bucket.time ?? ""}: ${String(bucket.success ?? 0)} ok / ${String(bucket.failed ?? 0)} failed`,
							style: { height: `${String(Math.max(height, total === 0 ? 2 : 4))}px` }
						},
						failHeight > 0 ? h("div", { className: "cps_sparkFail", key: "fail", style: { height: `${String(failHeight)}px` } }) : null
					);
				})
			);
		}

		/**
		 * One account: identity, CPA health, both rate-limit windows, traffic.
		 * @param props - the account model, the clock, and the translator.
		 */
		function AccountCard({ account, now, tr, onWrite, canWrite, canReset, canCredits, canRefresh }) {
			const [editing, setEditing] = react.useState(false);
			const [note, setNote] = react.useState(() => account.note ?? "");
			const [priority, setPriority] = react.useState(() => priorityTextOf(account));
			const [pending, setPending] = react.useState(false);
			const [writeError, setWriteError] = react.useState(null);
			// Reset credits are scarce and expiring, so the reset lives behind a
			// disclosure plus its own confirmation step and is never sent by opening
			// the panel, by a refresh, or by anything else automatic.
			const [creditsOpen, setCreditsOpen] = react.useState(false);
			const [confirmReset, setConfirmReset] = react.useState(false);
			const [resetDone, setResetDone] = react.useState(false);
			// The per-credit expiry lives on its own upstream endpoint, so it is fetched
			// when the disclosure opens rather than carried in every poll.
			const [creditDetail, setCreditDetail] = react.useState(null);
			const [creditBusy, setCreditBusy] = react.useState(false);
			const [refreshDone, setRefreshDone] = react.useState(false);
			const loadCredits = react.useCallback(async () => {
				if (canCredits !== true) return;
				setCreditBusy(true);
				try {
					const data = await fetchJson(`${CREDITS_URL}?authIndex=${encodeURIComponent(account.authIndex)}`);
					setCreditDetail(data !== null && typeof data === "object" && data.ok === true ? data : { ok: false, error: (data && data.error) || "reset credits failed" });
				} catch (error) {
					setCreditDetail({ ok: false, error: error instanceof Error ? error.message : String(error) });
				} finally {
					setCreditBusy(false);
				}
			}, [account.authIndex, canCredits]);
			const write = react.useCallback(
				async (body) => {
					setPending(true);
					setWriteError(null);
					const result = await onWrite({ authIndex: account.authIndex, ...body });
					setPending(false);
					if (result !== null) setWriteError(result);
					return result === null;
				},
				[account.authIndex, onWrite]
			);
			const tone = worstOf(account);
			const statusKey = account.disabled ? "status.disabled" : account.unavailable ? "status.unavailable" : `status.${account.status}`;
			const statusTone = account.disabled ? "muted" : account.usable ? "ok" : account.status === "active" ? "warn" : "bad";
			const meta = [tr("card.success", { count: account.success }), tr("card.failed", { count: account.failed })];
			if (priorityTextOf(account) !== "") meta.push(tr("card.priority", { value: priorityTextOf(account) }));
			const creditCount = Number(account.resetCredits ?? 0) || 0;
			const fetchedCredits = creditDetail?.ok === true && Array.isArray(creditDetail.credits) ? creditDetail.credits : null;
			const creditRows =
				fetchedCredits === null
					? resetCreditEntries(account.resetCreditsDetail)
					: fetchedCredits.map((credit) => ({
							title: typeof credit.title === "string" && credit.title !== "" ? credit.title : null,
							expiresAt: typeof credit.expiresAt === "number" ? credit.expiresAt : null,
							redeemedAt: typeof credit.redeemedAt === "number" ? credit.redeemedAt : null
						}));
			const shownCredits = creditDetail?.ok === true && Number.isFinite(creditDetail.availableCount) ? creditDetail.availableCount : creditCount;
			const showCredits = canReset === true && (shownCredits > 0 || account.resetCreditsDetail !== null);
			if (account.credits?.hasCredits === true && account.credits.balance !== null) meta.push(`credits ${String(account.credits.balance)}`);
			if (account.limitReached) meta.push(tr("card.limitReached"));
			return h("section", { className: "cps_card", "data-tone": tone ?? undefined, "data-dimmed": account.disabled ? "1" : undefined }, [
				h("div", { className: "cps_cardHead", key: "head" }, [
					h("div", { className: "cps_cardIdentity", key: "identity" }, [
						h("span", { className: "cps_cardName", key: "name", title: account.email || account.authIndex }, account.email || account.name || account.authIndex),
						h("span", { className: "cps_cardPlan", key: "plan" }, `${account.plan}${account.accountId ? ` · ${account.accountId.slice(0, 8)}` : ""}`)
					]),
					h("span", { className: "cps_chip", "data-tone": statusTone, key: "status" }, tr(statusKey) === statusKey ? tr("status.unknown") : tr(statusKey)),
					canWrite
						? h(
								"button",
								{
									type: "button",
									className: "cps_cardAction",
									key: "toggle",
									disabled: pending,
							title: account.disabled ? tr("card.enable") : tr("card.disable"),
							onClick: () => void write({ action: "status", disabled: !account.disabled })
								},
								pending ? tr("card.pending") : account.disabled ? tr("card.enable") : tr("card.disable")
							)
						: null,
					canWrite
						? h(
								"button",
								{ type: "button", className: "cps_cardAction", key: "edit", disabled: pending, onClick: () => setEditing((value) => !value) },
								tr("card.edit")
							)
						: null
				]),
				account.windows.length > 0
					? h(
							"div",
							{ key: "windows", style: { display: "flex", flexDirection: "column", gap: "7px" } },
							account.windows.map((window, index) => h(WindowRow, { key: `${window.label}-${String(index)}`, window, now, tr }))
						)
					: h("div", { className: "cps_cardMeta", key: "noWindow" }, tr("card.noWindow")),
				h("div", { className: "cps_cardMeta", key: "meta" }, [
					...meta.map((entry, index) => h("span", { key: `${String(index)}-${entry}` }, entry)),
					showCredits
						? h(
								"button",
								{
									type: "button",
									className: "cps_creditLink",
									key: "credits",
									"aria-expanded": creditsOpen,
									onClick: () => {
										const next = !creditsOpen;
										setCreditsOpen(next);
										setConfirmReset(false);
										setResetDone(false);
										if (next && creditDetail === null) void loadCredits();
									}
								},
								tr("card.resetCredits", { count: creditCount })
							)
						: null
				]),
				creditsOpen
					? h("div", { className: "cps_creditPanel", key: "creditsPanel" }, [
							h("div", { className: "cps_creditHead", key: "head" }, [
								h("span", { key: "title" }, tr("credits.title")),
								h("span", { key: "count" }, tr("credits.available", { count: shownCredits }))
							]),
							creditBusy
								? h("p", { className: "cps_hint", key: "loading" }, tr("credits.loading"))
								: creditRows.length > 0
									? h(
											"ul",
											{ className: "cps_creditList", key: "list" },
											creditRows.map((entry, index) =>
												h(
													"li",
													{ key: `credit-${String(index)}` },
													entry.title === null ? null : `${entry.title} · `,
													entry.redeemedAt === null ? null : tr("credits.redeemed", { time: stampText(entry.redeemedAt) }),
													entry.redeemedAt === null
														? entry.expiresAt === null
															? tr("credits.expiryUnknown")
															: tr("credits.expires", { time: stampText(entry.expiresAt) })
														: null
												)
											)
										)
									: h("p", { className: "cps_hint", key: "none" }, creditCount > 0 ? tr("credits.expiryUnknown") : tr("credits.none")),
							creditDetail?.ok === false ? h("p", { className: "cps_setFailed", key: "creditError" }, tr("credits.loadFailed", { error: creditDetail.error })) : null,
							h("p", { className: "cps_hint", key: "hint" }, tr("credits.hint")),
							confirmReset
								? h("div", { key: "confirm" }, [
										h("p", { className: "cps_creditWarn", key: "warn" }, tr("credits.confirm")),
										h("div", { className: "cps_creditActions", key: "actions" }, [
											h(
												"button",
												{ type: "button", className: "cps_setBtn cps_setBtnQuiet", key: "cancel", disabled: pending, onClick: () => setConfirmReset(false) },
												tr("credits.cancel")
											),
											h(
												"button",
												{
													type: "button",
													className: "cps_setBtn cps_setBtnDanger",
													key: "yes",
													disabled: pending,
													onClick: async () => {
														if (await write({ action: "reset" })) {
															setConfirmReset(false);
															setResetDone(true);
														}
													}
												},
												tr("credits.confirmYes")
											)
										])
									])
								: h("div", { className: "cps_creditActions", key: "actions" }, [
										h(
											"button",
											{ type: "button", className: "cps_setBtn cps_setBtnQuiet", key: "reset", disabled: pending || !canWrite || creditCount === 0, onClick: () => setConfirmReset(true) },
											pending ? tr("credits.working") : tr("credits.action")
										)
									]),
							canWrite ? null : h("p", { className: "cps_hint", key: "readonly" }, tr("credits.readOnly")),
							resetDone ? h("p", { className: "cps_hint", key: "done" }, tr("credits.done")) : null,
							writeError === null ? null : h("p", { className: "cps_setFailed", key: "error" }, writeError)
						])
					: null,
				account.note === "" ? null : h("div", { className: "cps_cardNote", key: "note" }, account.note),
				editing
					? h("div", { className: "cps_cardEditor", key: "editor" }, [
							h("label", { className: "cps_editorField", key: "note" }, [
								h("span", { className: "cps_hint", key: "label" }, tr("card.editNote")),
								h("input", {
									key: "input",
									className: "cps_input cps_inputSm",
									value: note,
									disabled: pending,
									onChange: (event) => setNote(event.target.value)
								})
							]),
							h("label", { className: "cps_editorField", key: "priority" }, [
								h("span", { className: "cps_hint", key: "label" }, tr("card.editPriority")),
								h("input", {
									key: "input",
									className: "cps_input cps_inputSm",
									value: priority,
									disabled: pending,
									inputMode: "numeric",
									onChange: (event) => setPriority(event.target.value)
								})
							]),
							canRefresh
								? h("div", { className: "cps_editorField", key: "refresh" }, [
										h("span", { className: "cps_hint", key: "label" }, tr("credits.refreshHint"))
									])
								: null,
							h("div", { className: "cps_editorActions", key: "actions" }, [
								canRefresh
									? h(
											"button",
											{
												type: "button",
												className: "cps_setBtn cps_setBtnQuiet",
												key: "refresh",
												disabled: pending,
												onClick: async () => {
													setRefreshDone(false);
													if (await write({ action: "refresh" })) setRefreshDone(true);
												}
											},
											pending ? tr("credits.refreshing") : tr("credits.refresh")
										)
									: null,
								canRefresh && refreshDone ? h("span", { className: "cps_hint", key: "refreshDone" }, tr("credits.refreshed")) : null,
								// Keeps the form's own actions right-aligned while the refresh
								// button shares the row, and stays harmless without it.
								h("span", { className: "cps_editorSpacer", key: "spacer" }),
								h(
									"button",
									{
										type: "button",
										className: "cps_setBtn cps_setBtnQuiet",
										key: "cancel",
										disabled: pending,
										onClick: () => {
											setNote(account.note ?? "");
											setPriority(priorityTextOf(account));
											setEditing(false);
											setWriteError(null);
										}
									},
									tr("card.cancel")
								),
								h(
									"button",
									{
										type: "button",
										className: "cps_setBtn cps_setBtnPrimary",
										key: "save",
										disabled: pending || (note === (account.note ?? "") && priority.trim() === priorityTextOf(account)),
										onClick: async () => {
											const patch = { action: "fields" };
											if (note !== (account.note ?? "")) patch.note = note;
											// A blank draft means "leave it alone", which is what the hint
											// promises; typing a number — 0 included — is what writes one.
											if (priority.trim() !== "" && priority.trim() !== priorityTextOf(account)) patch.priority = Number(priority.trim());
											if (await write(patch)) setEditing(false);
										}
									},
									tr("card.save")
								)
							]),
							h("p", { className: "cps_hint", key: "hint" }, tr("card.editPriorityHint"))
						])
					: null,
				writeError === null ? null : h("div", { className: "cps_cardError", key: "writeError" }, writeError),
				h(Sparkline, { key: "spark", buckets: account.recentRequests }),
				account.error ? h("div", { className: "cps_cardError", key: "error" }, account.error) : null
			]);
		}

		/**
		 * Sidebar footer occupant: badge plus the floating detail panel.
		 * @param props - `wide` from the sidebar shell, `t` bound by the slot runtime.
		 */
		/**
		 * The expanded body of one failed-request row: the parsed summary, the
		 * account chain behind it, and the raw log.
		 *
		 * Rendered INSIDE the row that asked for it, so expanding never moves the
		 * answer away from the control that was clicked.
		 *
		 * @param log - one parsed error log.
		 * @param tr - the bound translator.
		 * @returns the nodes to render under the row.
		 */
		function logDetailNodes(log, tr) {
			// What is worth expanding is the PARSED summary: the status, the error
			// triple, the model, the retry count, and the accounts each hop used.
			// The raw request body is not shown beside it — it is mostly prompt
			// payload, and reading it is a different task from "why did this fail".
			// It stays as the last resort for a log this parser could not read at
			// all, where an empty box would be worse than the text itself.
			const parsed =
				log.status !== null || log.errorMessage !== null || log.errorCode !== null || log.model !== null || log.attempts.length > 0;
			return [
			h("div", { className: "cps_diagRow", key: "head" }, [
				h("span", { className: `cps_diagStatus${log.status === null || log.status < 400 ? " cps_ok" : " cps_bad"}`, key: "status" }, log.status === null ? "—" : `HTTP ${String(log.status)}`),
				h("div", { className: "cps_diagMain", key: "main" }, [
					h(
						"span",
						{ className: "cps_diagMessage", key: "message" },
						log.errorMessage ?? log.errorCode ?? tr("diag.noMessage")
					),
					h("span", { className: "cps_diagMeta", key: "meta" }, [
						log.endpoint === null ? null : h("span", { key: "endpoint" }, log.endpoint),
						log.model === null ? null : h("span", { key: "model" }, log.model),
						h("span", { key: "attempts" }, tr("diag.attempts", { count: log.attempts.length })),
						h("span", { key: "stamp" }, stampText(log.at))
					])
				])
			]),
			log.accounts.length === 0
				? null
				: h(
						"span",
						{ className: "cps_diagMeta", key: "accounts" },
						`${tr("diag.accounts")}: ${log.accounts.map((account) => account.label || account.authId).join(" → ")}`
					),
			parsed ? null : h("pre", { className: "cps_diagText", key: "text" }, `${log.text}${log.truncated ? `\n${tr("diag.truncated")}` : ""}`)
			];
		}
		function CpaStatusPanel({ wide, t }) {
			const tr = react.useCallback((key, params) => interpolate((t !== undefined ? t(key) : undefined) ?? zh[key] ?? key, params), [t]);
			const [open, setOpen] = react.useState(false);
			const [payload, setPayload] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [now, setNow] = react.useState(() => Date.now());
			const [writing, setWriting] = react.useState(false);
			const [diagnostics, setDiagnostics] = react.useState(null);
			const [diagnosticsOpen, setDiagnosticsOpen] = react.useState(false);
			const [diagnosticsBusy, setDiagnosticsBusy] = react.useState(false);
			const [diagnosticsError, setDiagnosticsError] = react.useState(null);
			const [openLog, setOpenLog] = react.useState(null);
			const layerRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const seqRef = react.useRef(0);
			// Held in a ref so `load` never changes identity when the locale service
			// hands back a new translator on re-render; otherwise the polling effect
			// below would tear down and restart on every render.
			const trRef = react.useRef(tr);
			trRef.current = tr;

			// Declared before the callbacks that read them: a capability gate inside a
			// `useCallback` has to be in scope when React evaluates its dependency list.
			//
			// `null` means the server half predates this contract, i.e. it is running
			// older code than this hot-reloaded browser half. Everything added after
			// that point is hidden and explained, rather than left to fail on click.
			const capabilities = Array.isArray(payload?.capabilities) ? new Set(payload.capabilities) : null;
			const staleServer = payload !== null && capabilities === null;
			const canWrite = capabilities !== null && capabilities.has("account");
			const canDiagnose = capabilities !== null && capabilities.has("diagnostics");
			// The reset spends a scarce credit, so its control only appears when the
			// server half actually advertises the action — an older half would answer
			// `unknown action "reset"`, which is not a thing to discover by clicking.
			const canReset = capabilities !== null && capabilities.has("reset");
			const canCredits = capabilities !== null && capabilities.has("credits");

			const load = react.useCallback(
				(force) => {
					const seq = seqRef.current + 1;
					seqRef.current = seq;
					setLoading(true);
					const init = force === true ? { headers: { [ACTION_HEADER]: "refresh" } } : undefined;
					fetchJson(force === true ? REFRESH_URL : SNAPSHOT_URL, init)
						.then((data) => {
							if (seqRef.current !== seq) return;
							if (data !== null && typeof data === "object" && data.ok === true && data.snapshot) {
								setPayload(data);
								setError(null);
							} else {
								setError((data && (data.error ?? data.snapshot?.error)) || trRef.current("error.noTransport"));
							}
						})
						.catch((cause) => {
							if (seqRef.current !== seq) return;
							setError(cause instanceof Error ? cause.message : String(cause));
						})
						.finally(() => {
							if (seqRef.current === seq) setLoading(false);
						});
				},
				[]
			);

			// Badge data, refreshed on a fixed cadence whether or not the panel is open.
			react.useEffect(() => {
				load(false);
				const timer = setInterval(() => load(false), POLL_MS);
				return () => clearInterval(timer);
			}, [load]);

			/**
			 * Send one credential write, then fold the server's fresh snapshot into
			 * the panel. Resolves to an error string, or null on success.
			 */
			const writeAccount = react.useCallback(async (body) => {
				if (!canWrite) return trRef.current("card.staleWrite");
				setWriting(true);
				try {
					const data = await fetchJson(ACCOUNT_URL, {
						method: "POST",
						headers: { [ACTION_HEADER]: "write", "content-type": "application/json" },
						body: JSON.stringify(body)
					});
					if (data !== null && typeof data === "object" && data.ok === true && data.snapshot) {
						setPayload(data);
						setError(null);
						return null;
					}
					return (data && data.error) || "write failed";
				} catch (cause) {
					return cause instanceof Error ? cause.message : String(cause);
				} finally {
					setWriting(false);
				}
				// `canWrite` must be a dependency: with an empty list the callback keeps
				// the FIRST render's closure, where capabilities had not arrived yet.
			}, [canWrite]);

			/** Load the failure listing, or one log's body when `file` is given. */
			const loadDiagnostics = react.useCallback(async (file) => {
				setDiagnosticsBusy(true);
				setDiagnosticsError(null);
				try {
					const data = await fetchJson(file === undefined ? DIAGNOSTICS_URL : `${DIAGNOSTICS_URL}?file=${encodeURIComponent(file)}`);
					if (data !== null && typeof data === "object" && data.ok === true) {
						if (file === undefined) setDiagnostics(data);
						else setOpenLog(data.log);
						return;
					}
					setDiagnosticsError((data && data.error) || "diagnostics failed");
				} catch (cause) {
					setDiagnosticsError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setDiagnosticsBusy(false);
				}
			}, []);

			// Countdowns and the "updated at" stamp.
			react.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), TICK_MS);
				return () => clearInterval(timer);
			}, []);

			// Several footer actions share a nowrap flex row; let them wrap instead.
			react.useEffect(() => {
				let host = layerRef.current?.parentElement ?? null;
				for (let depth = 0; host !== null && depth < 3; depth += 1) {
					if (window.getComputedStyle(host).display.includes("flex")) break;
					host = host.parentElement;
				}
				if (host === null) return undefined;
				return enableFooterActionWrapping(host);
			}, []);

			// Popover dismissal: the panel is portaled, so match on the event path.
			react.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const path = typeof event.composedPath === "function" ? event.composedPath() : [];
					if (shouldDismissPanel(path, event.target, layerRef.current, panelRef.current)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [open]);

			const snapshot = payload?.snapshot ?? null;
			// `null` means the server half predates this contract, i.e. it is running
			// older code than this hot-reloaded browser half. Everything added after
			// that point is hidden and explained, rather than left to fail on click.
			const accounts = snapshot?.accounts ?? [];
			const counts = snapshot?.counts ?? null;
			const picked = pickBadge(snapshot);
			// An older server half reports no `badgeMode`; `lowest` is the historical
			// behaviour, so an absent field must mean that rather than nothing.
			const badgeMode = payload?.config?.badgeMode === "total" ? "total" : "lowest";
			const badgeValuesByWindow = badgeValues(snapshot, badgeMode);
			const badgeValue = picked === null ? "—" : remainingText(badgeValuesByWindow);
			const badgeAccount = picked === null ? "" : picked.account.email || picked.account.authIndex;
			// A server half older than the capability contract reports no `cpa` block:
			// show no chip at all rather than claiming the version is unknown. A block
			// with a null version means CPA itself omitted the header, which is worth
			// saying out loud.
			const cpa = capabilities !== null && capabilities.has("cpa") ? (snapshot?.cpa ?? null) : null;
			// The refresh route exists on v8 only, so the control does too. Read from
			// `cpa` rather than `snapshot`: the latter is declared further down, and
			// touching it up there dereferences an uninitialised binding.
			const canRefresh = capabilities !== null && capabilities.has("refresh") && (cpa?.api ?? null) === "v8";
			const versionChip =
				cpa === null
					? null
					: h(
							"span",
							{
								key: "cpaVersion",
								title: cpa.version === null ? tr("version.unknown") : `${cpa.version}${cpa.commit === null ? "" : ` (${cpa.commit.slice(0, 7)})`}`
							},
							cpa.version === null ? tr("version.unknown") : tr("version.label", { version: cpa.version })
						);
			const versionUpdate = cpa?.updateAvailable === true ? h("span", { className: "cps_warn", key: "cpaUpdate" }, tr("version.update", { latest: cpa.latestVersion })) : null;
			// The tone describes the figure actually on screen, in both modes. A pool
			// load-balances: one exhausted account just means traffic moves to the next
			// one, so a single 0% must not paint a healthy aggregate red. In `lowest`
			// mode the displayed account IS the critical one, so the warning survives
			// exactly where it is meaningful.
			const shownValues = BADGE_WINDOWS.map((label) => badgeValuesByWindow[label]).filter((value) => typeof value === "number");
			const tone = shownValues.length === 0 ? "muted" : toneOfRemaining(Math.min(...shownValues));
			const stale = error !== null;

			const badge = h(
				"button",
				{
					type: "button",
					key: "badge",
					className: "cps_badge",
					"data-active": open ? "1" : undefined,
					title:
						stale || picked === null
							? stale
								? error
								: tr("badge.tip")
							: badgeMode === "total"
								? tr("badge.tipTotal", { value: badgeValue })
								: tr("badge.tipAccount", { value: badgeValue, account: badgeAccount }),
					"aria-label": tr("badge.tip"),
					onClick: () => {
						setOpen((value) => !value);
						if (!open) load(false);
					}
				},
				// A 16px outline icon leads the row exactly like the Settings entry
				// beside it, in the row's neutral color: the tone rides the value only,
				// so the glyph never turns red just because a quota is low. The
				// percentage sits right after the label, like the balance in the usage
				// row above; only the account count is pushed to the far edge.
				wide
					? [
							h(
								"span",
								{ className: "cps_iconWrap", key: "icon" },
								Icon(["IconGaugeOutlineRegular", "IconGaugeOutline16"], { size: 16 }) ?? h("span", { className: "cps_dot" })
							),
							h("span", { className: "cps_badgeLabel", key: "label" }, tr("badge.label")),
							h("span", { className: `cps_badgeAmount cps_${tone}`, key: "value" }, badgeValue),
							counts ? h("span", { className: "cps_badgeCount", key: "count" }, `${String(counts.active)}/${String(counts.total)}`) : null
						]
					: h(
							"span",
							{ className: "cps_iconWrap", key: "icon" },
							Icon(["IconGaugeOutlineRegular", "IconGaugeOutline16"], { size: 16 }) ?? h("span", { className: "cps_dot" })
						)
			);

			const panel = open && typeof document !== "undefined"
				? react_dom.createPortal(
						h("section", { ref: panelRef, key: "panel", className: "cps_panel", "data-cpa-status-panel": "1", "aria-label": tr("panel.title") }, [
							h("header", { className: "cps_header", key: "header" }, [
								h("div", { className: "cps_headerLeft", key: "left" }, [
									Icon("IconGaugeOutline16", { size: 16, key: "mark" }),
									h("div", { key: "identity", style: { display: "flex", flexDirection: "column" } }, [
										h("span", { className: "cps_title", key: "title" }, tr("panel.title")),
										h(
											"span",
											{ className: "cps_subtitle", key: "subtitle" },
											snapshot
												? tr("panel.subtitle", { time: clockText(snapshot.fetchedAt), endpoint: snapshot.baseURL })
												: tr("panel.subtitlePending")
										)
									])
								]),
								h("div", { className: "cps_headerActions", key: "actions" }, [
									h(
										"button",
										{
											type: "button",
											className: "cps_iconButton",
											key: "refresh",
											title: tr("action.refresh"),
											"aria-label": tr("action.refresh"),
											disabled: loading,
											onClick: () => load(true)
										},
										Icon(["IconRefreshOutlineRegular", "IconRefreshOutline16"], { size: 16, className: loading ? "cps_spin" : undefined }) ?? tr("action.refresh")
									),
									h(
										"button",
										{
											type: "button",
											className: "cps_iconButton",
											key: "close",
											title: tr("action.close"),
											"aria-label": tr("action.close"),
											onClick: () => setOpen(false)
										},
										Icon(["IconCloseOutlineRegular", "IconCloseOutline16"], { size: 16 }) ?? "×"
									)
								])
							]),
							h("div", { className: "cps_body", key: "body" }, [
								staleServer
									? h("div", { className: "cps_alert", key: "staleServer" }, [
											h("span", { className: "cps_alertText", key: "text" }, `${tr("stale.title")}：${tr("stale.body")}`)
										])
									: null,
								stale
									? h("div", { className: "cps_alert", key: "alert" }, [
											h("span", { className: "cps_alertText", key: "text" }, error),
											h("button", { type: "button", className: "cps_retry", key: "retry", onClick: () => load(true) }, tr("action.retry"))
										])
									: null,
								counts
									? h("div", { className: "cps_summary", key: "summary" }, [
											h("div", { className: "cps_summaryRow", key: "row" }, [
												h(
													"span",
													{
														className: "cps_summaryValue",
														key: "value",
														title:
															badgeMode === "total"
																? tr("summary.totalHint")
																: picked === null
																	? undefined
																	: `${tr("summary.tightest")}：${badgeAccount}`
													},
													badgeValue
												),
												h("span", { className: "cps_summaryLabel", key: "label" }, tr(`summary.mode.${badgeMode}`))
											]),
											h("div", { className: "cps_summaryMeta", key: "meta" }, [
												h("span", { key: "accounts" }, tr("summary.accounts", { active: counts.active, total: counts.total })),
												snapshot.attention > 0 ? h("span", { className: "cps_bad", key: "attention" }, tr("summary.attention", { count: snapshot.attention })) : null,
												counts.disabled > 0 ? h("span", { key: "disabled" }, tr("summary.disabled", { count: counts.disabled })) : null,
												h("span", { key: "duration" }, `${String(snapshot.durationMs)}ms`),
												versionChip,
												versionUpdate
											])
										])
									: null,
								accounts.length === 0
									? h("div", { className: "cps_empty", key: "empty" }, tr("summary.empty", { provider: snapshot?.providerFilter ?? "codex" }))
									: accounts.map((account) => h(AccountCard, { key: account.authIndex, account, now, tr, onWrite: writeAccount, canWrite, canReset, canCredits, canRefresh })),
								snapshot === null || !canDiagnose
									? null
									: h("div", { className: "cps_section", key: "diagnostics" }, [
											h("div", { className: "cps_cardHead", key: "head" }, [
												h("div", { className: "cps_cardIdentity", key: "title" }, [
													h("span", { className: "cps_cardName", key: "name" }, tr("diag.title")),
													h(
														"span",
														{ className: "cps_cardPlan", key: "state" },
														diagnostics === null
															? ""
															: diagnostics.requestLogEnabled === true
																? tr("diag.requestLogOn")
																: `${String(diagnostics.files.length)}`
													)
												]),
												diagnosticsBusy ? h("span", { className: "cps_hint", key: "busy" }, tr("diag.loading")) : null,
												h(
													"button",
													{
														type: "button",
														className: "cps_cardAction",
														key: "toggle",
														onClick: () => {
															const next = !diagnosticsOpen;
															setDiagnosticsOpen(next);
															if (next) void loadDiagnostics();
														}
													},
													diagnosticsOpen ? tr("diag.hide") : tr("diag.show")
												)
											]),
											diagnosticsOpen
												? [
														diagnosticsError === null ? null : h("div", { className: "cps_cardError", key: "error" }, diagnosticsError),
														diagnostics === null || diagnostics.requestLogEnabled === true
															? null
															: diagnostics.files.length === 0
																? h("div", { className: "cps_hint", key: "empty" }, tr("diag.empty"))
																: h(
																		"div",
																		{ key: "rows" },
																		diagnostics.files.map((file) => {
																			const isOpen = openLog !== null && openLog.name === file.name;
																			return h("div", { className: "cps_diagItem", key: file.name, "data-open": isOpen ? "1" : undefined }, [
																				h("div", { className: "cps_diagRow", key: "row" }, [
																					h("span", { className: "cps_diagTime", key: "at" }, stampText(file.at ?? file.modified)),
																					h("div", { className: "cps_diagMain", key: "main" }, [
																						h("span", { className: "cps_diagMessage", key: "name", title: file.name }, file.endpoint === null ? file.name : `${file.method ?? ""} ${file.endpoint}`.trim()),
																						h("span", { className: "cps_diagMeta", key: "meta" }, [h("span", { key: "size" }, sizeText(file.size))])
																					]),
																					h(
																						"button",
																						{
																							type: "button",
																							className: "cps_cardAction",
																							key: "open",
																							disabled: diagnosticsBusy,
																							"aria-expanded": isOpen,
																							onClick: () => {
																								// Toggle in place. The raw text renders directly under this row, so
																								// the control never looks like it did nothing.
																								if (isOpen) {
																									setOpenLog(null);
																									return;
																								}
																								setOpenLog(null);
																								void loadDiagnostics(file.name);
																							}
																						},
																						isOpen ? tr("diag.hide") : tr("diag.open")
																					)
																				]),
																				isOpen ? h("div", { className: "cps_diagDetail", key: "detail" }, logDetailNodes(openLog, tr)) : null
																			]);
																		})
																	),
													]
												: null
										]),
								snapshot ? h("div", { className: "cps_note", key: "note" }, tr("note.countdown")) : null
							])
						]),
						document.body
					)
				: null;

			return h("div", { ref: layerRef, className: wide ? "cps_layer" : "cps_layer cps_rail" }, badge, panel);
		}
		//#endregion

		//#region settings card
		/**
		 * Fields the settings card edits, in render order.
		 *
		 * `kind` decides the control and the stored/draft conversion; the labels
		 * and hints are locale keys resolved by the card.
		 */
		const SETTINGS_FIELDS = [
			{ field: "baseURL", kind: "text", label: "settings.baseURL", hint: "settings.baseURL.hint", placeholder: "https://cpa.example.com:8317" },
			{ field: "managementKey", kind: "secret", label: "settings.managementKey", hint: "settings.managementKey.hint" },
			{ field: "proxies", kind: "list", label: "settings.proxies", hint: "settings.proxies.hint", placeholder: "http://127.0.0.1:1080" },
			{ field: "allowDirect", kind: "bool", label: "settings.allowDirect", hint: "settings.allowDirect.hint" },
			{ field: "refreshIntervalMs", kind: "seconds", label: "settings.refreshIntervalMs", hint: "settings.refreshIntervalMs.hint" },
			{ field: "timeoutMs", kind: "seconds", label: "settings.timeoutMs", hint: "settings.timeoutMs.hint" },
			{ field: "connectTimeoutMs", kind: "seconds", label: "settings.connectTimeoutMs", hint: "settings.connectTimeoutMs.hint" },
			{ field: "providerFilter", kind: "text", label: "settings.providerFilter", hint: "settings.providerFilter.hint" },
			{ field: "includeDisabled", kind: "bool", label: "settings.includeDisabled", hint: "settings.includeDisabled.hint" },
			{
				field: "badgeMode",
				kind: "enum",
				label: "settings.badgeMode",
				hint: "settings.badgeMode.hint",
				options: [
					{ value: "lowest", label: "settings.badgeMode.lowest" },
					{ value: "total", label: "settings.badgeMode.total" }
				]
			},
			{ field: "timeZone", kind: "text", label: "settings.timeZone", hint: "settings.timeZone.hint" },
			{ field: "insecure", kind: "bool", label: "settings.insecure", hint: "settings.insecure.hint" }
		];

		/** Every field the card can clear back to the composition layer. */
		const SETTINGS_FIELD_NAMES = SETTINGS_FIELDS.map((spec) => spec.field);

		/**
		 * Render one stored value as the control's draft text.
		 *
		 * A `secret` field always drafts blank: the wire never carries it (the
		 * settings service strips `role('secret')` positions entirely), and a blank
		 * draft must therefore mean "leave the stored key alone" rather than "the
		 * key is empty".
		 */
		function formatField(spec, value) {
			if (spec.kind === "secret") return "";
			if (value === undefined || value === null) return "";
			if (spec.kind === "list") return Array.isArray(value) ? value.join("\n") : String(value);
			if (spec.kind === "bool") return value === true ? "true" : "false";
			if (spec.kind === "seconds") {
				const milliseconds = Number(value);
				return Number.isFinite(milliseconds) ? String(Math.round(milliseconds / 100) / 10) : "";
			}
			return String(value);
		}

		/**
		 * Convert one draft back into a write.
		 * @returns `{op:"set"}`, `{op:"clear"}` for a reset, `{op:"skip"}` for a
		 * write-less draft, or undefined when the draft is not a value this field
		 * accepts (which blocks the save).
		 */
		function parseField(spec, text) {
			const trimmed = String(text ?? "").trim();
			if (spec.kind === "bool") return { op: "set", value: trimmed === "true" };
			// A write-only credential: blank drafts are not an edit at all, and
			// clearing the stored key is the explicit 清除 action instead.
			if (spec.kind === "secret") return trimmed === "" ? { op: "skip" } : { op: "set", value: trimmed };
			if (trimmed === "") return { op: "clear" };
			if (spec.kind === "seconds") {
				const seconds = Number(trimmed);
				if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
				return { op: "set", value: Math.round(seconds * 1000) };
			}
			if (spec.kind === "list") {
				return { op: "set", value: trimmed.split(/[\n,]+/).map((entry) => entry.trim()).filter((entry) => entry !== "") };
			}
			if (spec.kind === "enum") {
				const allowed = (spec.options ?? []).map((option) => option.value);
				return allowed.includes(trimmed) ? { op: "set", value: trimmed } : undefined;
			}
			return { op: "set", value: trimmed };
		}

		/**
		 * Subscribe to a bound settings scope as a React store.
		 *
		 * A missing scope reads as `undefined` instead of subscribing, so the
		 * Plugins-page variant can call this unconditionally (hooks may not be
		 * conditional) while feeding the form's own state in as the snapshot.
		 *
		 * @param scope - the bound namespace scope, or undefined for the form variant.
		 * @returns the current snapshot, or undefined when there is no scope.
		 */
		function useScopeSnapshot(scope) {
			const subscribe = react.useCallback((notify) => (scope === undefined ? () => {} : scope.subscribe(notify)), [scope]);
			const read = react.useCallback(() => (scope === undefined ? undefined : scope.getSnapshot()), [scope]);
			return react.useSyncExternalStore(subscribe, read, read);
		}

		/**
		 * One settings field: label, staged control, override badge, and reset.
		 * @param props - the field spec, its draft state, and the edit actions.
		 */
		function SettingsField({ spec, draft, overridden, invalid, disabled, tr, onEdit, onReset }) {
			const id = `cps-set-${spec.field}`;
			const invalidText = invalid ? tr("settings.state.invalid") : undefined;
			const hint = h("span", { className: invalid ? "cps_hintBad" : "cps_hint", key: "hint" }, invalid ? invalidText : tr(spec.hint));
			let control;
			if (spec.kind === "bool") {
				control = h(
					"label",
					{ className: "cps_checkRow", htmlFor: id, key: "control" },
					h("input", {
						id,
						type: "checkbox",
						checked: draft === "true",
						disabled,
						onChange: (event) => onEdit(event.target.checked ? "true" : "false")
					}),
					h("span", { className: "cps_hint" }, draft === "true" ? tr("settings.boolOn") : tr("settings.boolOff"))
				);
			} else if (spec.kind === "enum") {
				control = h(
					"select",
					{
						id,
						key: "control",
						className: "cps_input cps_select",
						value: draft,
						disabled,
						"data-invalid": invalid ? "1" : undefined,
						onChange: (event) => onEdit(event.target.value)
					},
					(spec.options ?? []).map((option) => h("option", { key: option.value, value: option.value }, tr(option.label)))
				);
			} else if (spec.kind === "list") {
				control = h("textarea", {
					id,
					key: "control",
					className: "cps_input cps_textarea",
					rows: 3,
					value: draft,
					disabled,
					placeholder: spec.placeholder,
					"data-invalid": invalid ? "1" : undefined,
					onChange: (event) => onEdit(event.target.value)
				});
			} else {
				control = h("input", {
					id,
					key: "control",
					className: "cps_input",
					type: spec.kind === "secret" ? "password" : "text",
					value: draft,
					disabled,
					placeholder: spec.kind === "secret" ? tr("settings.secretPlaceholder") : spec.placeholder,
					autoComplete: spec.kind === "secret" ? "off" : undefined,
					"data-invalid": invalid ? "1" : undefined,
					onChange: (event) => onEdit(event.target.value)
				});
			}
			return h("div", { className: "cps_field" }, [
				h("div", { className: "cps_fieldHead", key: "head" }, [
					h("label", { className: "cps_fieldLabel", htmlFor: id, key: "label" }, tr(spec.label)),
					h(
						"span",
						{ className: "cps_fieldBadges", key: "badges" },
						overridden
							? [
									h("span", { className: "cps_fieldBadge", key: "badge" }, tr("settings.overridden")),
									h(
										"button",
										{ type: "button", className: "cps_fieldClear", key: "clear", disabled, onClick: () => onReset() },
										tr("settings.clear")
									)
								]
							: null
					)
				]),
				control,
				hint
			]);
		}

		/**
		 * The plugin's configuration form.
		 *
		 * Two hosts render it, and each hands its state over differently:
		 *
		 * - the legacy Settings card (DSH ≤ 0.1.x) passes a bound namespace
		 *   `scope`, which this component subscribes to;
		 * - the Plugins page's row page (DSH ≥ 0.2) passes the host-owned `form`
		 *   as a plain value and re-renders on change, so the snapshot comes
		 *   straight from `form.state`.
		 *
		 * Either way the staged-draft model here is the only place a value becomes
		 * a write, and every save is one revision-fenced document mutation.
		 *
		 * @param props - the bound `scope`, the Plugins-page `form`, the `t` bound
		 * by the slot runtime, and the `variant` choosing the card chrome.
		 */
		function CpaSettingsForm({ scope, form, t, variant }) {
			const tr = react.useCallback((key, params) => interpolate((t !== undefined ? t(key) : undefined) ?? zh[key] ?? key, params), [t]);
			const bound = useScopeSnapshot(scope);
			const snapshot = form !== undefined ? form.state : bound;
			// Disclosure is card-local state, like every other card in the section;
			// staged edits deliberately outlive collapsing, so the header keeps
			// reporting them while the body is closed.
			const [open, setOpen] = react.useState(false);
			const [drafts, setDrafts] = react.useState({});
			const [saving, setSaving] = react.useState(false);
			const [failed, setFailed] = react.useState(null);

			// A namespace this client is not served leaves no trace at all; an
			// unwritable one still renders, with its controls disabled. The check
			// sits after every hook below so the hook order never depends on it.
			const unavailable = snapshot === undefined || snapshot.status === "unavailable";
			const value = snapshot?.value ?? {};
			const user = snapshot?.user !== null && typeof snapshot?.user === "object" ? snapshot.user : {};
			const writable = snapshot?.writable !== false;
			const staged = SETTINGS_FIELDS.filter((spec) => Object.prototype.hasOwnProperty.call(drafts, spec.field));
			const invalidSpecs = staged.filter((spec) => drafts[spec.field].clear !== true && parseField(spec, drafts[spec.field].text) === undefined);
			const dirty = staged.length > 0;
			const invalid = invalidSpecs.length > 0;
			const overriddenOf = (spec) => {
				const draft = drafts[spec.field];
				if (draft !== undefined) return draft.clear !== true;
				return Object.prototype.hasOwnProperty.call(user, spec.field);
			};
			const draftOf = (spec) => {
				const draft = drafts[spec.field];
				if (draft === undefined) return formatField(spec, value[spec.field]);
				return draft.clear === true ? "" : draft.text;
			};
			const stage = (field, text) => {
				setDrafts((previous) => ({ ...previous, [field]: { text } }));
				setFailed(null);
			};
			const reset = (field) => {
				setDrafts((previous) => ({ ...previous, [field]: { clear: true } }));
				setFailed(null);
			};
			const apply = react.useCallback(
				async (plan) => {
					setSaving(true);
					setFailed(null);
					try {
						if (form !== undefined) {
							// The Plugins page owns the write queue: answer it with
							// path-addressed operations and the revision we read, and
							// treat a refusal as a failure worth reporting.
							const ops = plan.map((step) =>
								step.op === "clear"
									? { op: "unset", path: [step.field] }
									: { op: "set", path: [step.field], value: step.value }
							);
							const accepted = await form.mutate(ops, form.state === undefined ? undefined : form.state.revision);
							if (accepted !== true) throw new Error(tr("settings.writeFailed"));
						} else {
							for (const step of plan) {
								if (step.op === "clear") await scope.unset(step.field);
								else await scope.set(step.field, step.value);
							}
						}
						setDrafts({});
					} catch (error) {
						setFailed(error instanceof Error ? error.message : String(error));
					} finally {
						setSaving(false);
					}
				},
				[scope, form, tr]
			);
			const save = () => {
				if (!writable || !dirty || invalid) return;
				const plan = [];
				for (const spec of staged) {
					const draft = drafts[spec.field];
					if (draft.clear === true) {
						plan.push({ op: "clear", field: spec.field });
						continue;
					}
					const parsed = parseField(spec, draft.text);
					if (parsed === undefined) return;
					if (parsed.op === "skip") continue;
					plan.push(parsed.op === "clear" ? { op: "clear", field: spec.field } : { op: "set", field: spec.field, value: parsed.value });
				}
				void apply(plan);
			};
			const resetAll = () => {
				if (!writable) return;
				void apply(SETTINGS_FIELD_NAMES.map((field) => ({ op: "clear", field })));
			};

			// The shipped cards fold themselves once a save has landed: the disclosure
			// is about acting on the settings, and a landed save ends that gesture.
			const saveLanded = react.useRef(false);
			react.useEffect(() => {
				if (saving) {
					saveLanded.current = true;
					return;
				}
				if (!saveLanded.current) return;
				saveLanded.current = false;
				if (!dirty && failed === null) setOpen(false);
			}, [saving, dirty, failed]);

			const body = h("div", { className: variant === "page" ? "cps_setPageBody" : "cps_setBody", key: "body" }, [
				h(
					"div",
					{ key: "fields" },
					SETTINGS_FIELDS.map((spec) =>
						h(SettingsField, {
							key: spec.field,
							spec,
							draft: draftOf(spec),
							overridden: overriddenOf(spec),
							invalid: invalidSpecs.includes(spec),
							disabled: !writable || saving,
							tr,
							onEdit: (text) => stage(spec.field, text),
							onReset: () => reset(spec.field)
						})
					)
				),
				writable ? null : h("p", { className: "cps_setReadOnly", key: "readonly" }, tr("settings.readOnly")),
				h("div", { className: "cps_setFoot", key: "foot" }, [
					failed !== null
						? h("p", { className: "cps_setFailed", key: "note" }, failed)
						: h("p", { className: "cps_setNote", key: "note" }, tr("settings.footNote")),
					h(
						"button",
						{ type: "button", className: "cps_setBtn cps_setBtnQuiet", key: "resetAll", disabled: !writable || saving, onClick: resetAll },
						tr("settings.action.resetAll")
					),
					h(
						"button",
						{ type: "button", className: "cps_setBtn cps_setBtnQuiet", key: "discard", disabled: !dirty || saving, onClick: () => setDrafts({}) },
						tr("settings.action.discard")
					),
					h(
						"button",
						{ type: "button", className: "cps_setBtn cps_setBtnPrimary", key: "save", disabled: !writable || !dirty || invalid || saving, onClick: save },
						tr("settings.action.save")
					)
				])
			]);

			if (unavailable) return null;
			// The Plugins page draws the title, the icon, and the crumb itself, so
			// the page variant renders the form alone instead of a second card.
			if (variant === "page") {
				return h(
					"div",
					{ className: "cps_setInline", "data-cpa-status-settings": "1", "data-cpa-form": snapshot.status },
					[
						dirty ? h("p", { className: "cps_setInlineHead", key: "unsaved" }, tr("settings.unsaved")) : null,
						body
					]
				);
			}
			return h("li", { className: "cps_set", "data-cpa-status-settings": "1", "data-open": open ? "1" : undefined }, [
				h(
					"button",
					{
						type: "button",
						key: "header",
						className: "cps_setHeader",
						"aria-expanded": open,
						"aria-label": `${tr(open ? "settings.collapse" : "settings.expand")}: ${tr("settings.title")}`,
						onClick: () => setOpen((value) => !value)
					},
					[
						h(
							"span",
							{ className: "cps_setHeadText", key: "text" },
							h("span", { className: "cps_setTitle", key: "title" }, tr("settings.title")),
							h("span", { className: "cps_setDesc", key: "desc" }, tr("settings.description"))
						),
						dirty ? h(StateTag, { key: "unsaved" }, tr("settings.unsaved")) : null,
						h(
							"span",
							{ className: "cps_setChevron", key: "chevron", "data-open": open ? "1" : undefined, "aria-hidden": "true" },
							Icon(["IconChevronDownOutlineRegular", "IconChevronDownOutline14"], { size: 14 }) ?? null
						)
					]
				),
				open ? body : null
			]);
		}

		/**
		 * The legacy Settings card (DSH ≤ 0.1.x): the `settings.plugin.item` occupant.
		 *
		 * @param props - the bound `scope` and the `t` bound by the slot runtime.
		 */
		function CpaSettingsCard({ scope, t }) {
			return h(CpaSettingsForm, { scope, t, variant: "card" });
		}

		/**
		 * The Plugins-page row page (DSH ≥ 0.2): the `plugins.row.config` occupant
		 * keyed `dsh-cpa-monitor#cpa-monitor`.
		 *
		 * The page dispatches `view: 'summary'` when it needs a one-liner instead of
		 * the form — a row whose package description is missing — and `view: 'page'`
		 * with the host-owned `form` when the row's own page opens.
		 *
		 * The page exists as soon as a `plugins.row.config` entry names the row, but
		 * the form comes from the HOST: it derives one from the server half's
		 * exported schema, and hands nothing over when it cannot. Saying so beats
		 * the empty page that would otherwise be the whole symptom.
		 *
		 * @param props - the page's `view`, the host-owned `form`, and the `t` bound
		 * by the slot runtime.
		 */
		function CpaRowConfig({ view, form, t }) {
			const tr = (key) => (t !== undefined ? t(key) : undefined) ?? zh[key] ?? key;
			if (view !== "page") return h("span", { className: "cps_setDesc" }, tr("settings.description"));
			if (form === undefined) {
				return h(
					"div",
					{ className: "cps_setInline", "data-cpa-status-settings": "1", "data-cpa-form": "missing" },
					h("p", { className: "cps_setInlineHead" }, tr("settings.formMissing"))
				);
			}
			return h(CpaSettingsForm, { form, t, variant: "page" });
		}
		//#endregion

		//#region plugin body
		/**
		 * Services required by the client plugin body.
		 *
		 * `settingsScope` is deliberately NOT listed: activation waits for every
		 * injected service, so requiring the settings client would take the sidebar
		 * badge down with it on a deployment that composes no settings UI. The card
		 * joins through the optional injection inside `apply` instead.
		 */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register dictionaries, the sidebar badge, and the
		 * configuration form for whichever generation of host composes it.
		 *
		 * Two configuration hosts exist across the supported DSH range, and each
		 * one only dispatches what it declares, so both registrations are made
		 * unconditionally and exactly one of them lands:
		 *
		 * - DSH ≥ 0.2 renders plugin configuration on the sidebar Plugins page
		 *   (`plugins.row.config`, keyed `<package>#<row id>`) and passes the form
		 *   in; the Settings page that hosted DSH ≤ 0.1 cards, and the
		 *   `settingsScope` service behind it, no longer exist there.
		 * - DSH ≤ 0.1 hosts the card in Settings → Plugins
		 *   (`settings.plugin.item`, keyed by the namespace) and supplies a bound
		 *   scope instead.
		 *
		 * Either way the server half registers the same `cpa-monitor` settings
		 * namespace, so a deployment that composes neither host still monitors;
		 * it just has nowhere to edit the endpoint from.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "cpa-monitor: dictionaries");
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "cpa-monitor",
						locale: NS,
						order: 20
					},
					CpaStatusPanel
				)
			);
			// DSH ≥ 0.2: the configuration page moved out of Settings and onto the
			// sidebar Plugins page, which declares `plugins.row.config` while it is
			// mounted. `slots.inject` waits for that declaration, so this branch is
			// simply never dispatched on a deployment whose page is not composed —
			// while the legacy branch below still serves DSH ≤ 0.1.x.
			ctx.slots.inject("plugins.row.config", () =>
				ctx.slots.register(
					{
						name: "plugins.row.config",
						key: ROW_CONFIG_KEY,
						locale: NS
					},
					CpaRowConfig
				)
			);
			// DSH ≤ 0.1: Settings → Plugins, where the section pairs the card with
			// the namespace the server half registers and binds the scope for it.
			ctx.inject(["settingsScope"], (settingsCtx) => {
				const scope = settingsCtx.settingsScope.bind({ namespace: NS });
				settingsCtx.slots.inject("settings.plugin.item", () =>
					settingsCtx.slots.register(
						{
							name: "settings.plugin.item",
							key: NS,
							locale: NS,
							inject: () => ({ scope })
						},
						CpaSettingsCard
					)
				);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.CpaStatusPanel = CpaStatusPanel;
		exports.AccountCard = AccountCard;
		exports.WindowRow = WindowRow;
		exports.Sparkline = Sparkline;
		exports.interpolate = interpolate;
		exports.durationText = durationText;
		exports.resetText = resetText;
		exports.toneOfRemaining = toneOfRemaining;
		exports.worstOf = worstOf;
		exports.shouldDismissPanel = shouldDismissPanel;
		exports.enableFooterActionWrapping = enableFooterActionWrapping;
		exports.pickBadge = pickBadge;
		exports.sizeText = sizeText;
		exports.priorityTextOf = priorityTextOf;
		exports.resetCreditEntries = resetCreditEntries;
		exports.stampText = stampText;
		exports.windowRemaining = windowRemaining;
		exports.sumRemaining = sumRemaining;
		exports.remainingText = remainingText;
		exports.badgeValues = badgeValues;
		exports.BADGE_WINDOWS = BADGE_WINDOWS;
		exports.BADGE_SHORT_THRESHOLD = BADGE_SHORT_THRESHOLD;
		exports.CpaSettingsCard = CpaSettingsCard;
		exports.CpaSettingsForm = CpaSettingsForm;
		exports.CpaRowConfig = CpaRowConfig;
		exports.ROW_CONFIG_KEY = ROW_CONFIG_KEY;
		exports.SettingsField = SettingsField;
		exports.SETTINGS_FIELDS = SETTINGS_FIELDS;
		exports.formatField = formatField;
		exports.parseField = parseField;
		exports.useScopeSnapshot = useScopeSnapshot;
		exports.zh = zh;
		exports.en = en;
		return module.exports;
	}
});
