# 데모 영상 콘티 (2분 50초 · Base·Reactive 공용)

## 녹화 전 준비 (10분)

- 해상도: 1920×1080, 화면녹화는 Loom(무료로 충분) 또는 QuickTime → 새로운 화면 기록
- 방해 금지 모드 켜기 (알림 팝업 차단), 데스크톱 아이콘 숨기기
- Chrome: 시크릿 창 하나, 북마크바·확장 아이콘 숨기기, 확대 125%
- 터미널: 글꼴 크기 18 이상, 배경 어둡게, 이전 출력 지우기(`clear`)
- `.env` 파일·개인키·이메일이 화면에 절대 안 나오게 할 것
- 미리 열어둘 탭 (순서대로):
  1. `http://localhost:5173` (보드)
  2. 텔레그램 채널 (경보 메시지가 1개 이상 있는 상태)
  3. Base Sepolia 익스플로러 — 드릴 origin tx
  4. Reactive Lasna 익스플로러 — 센티넬 컨트랙트
  5. Base Sepolia 익스플로러 — 콜백 tx (`CircuitBreakerTriggered` 로그 탭)
- 브레이커가 해제된 상태에서 시작 (드릴을 녹화 중에 실행할 경우)

## 화면 배치 원칙

- 한 장면에 하나만 보여주기. 마우스는 천천히, 클릭할 곳에 1초 머무르기
- 숫자가 중요한 장면은 브라우저 확대(⌘ +)로 크게
- 드릴 장면만 화면 2분할: 왼쪽 터미널 / 오른쪽 익스플로러
- 자막은 화면 하단 1줄, 영어, 짧게 (CapCut 자동 자막 후 수정)

## 콘티

| # | 시간 | 화면 | 동작 | 자막 / 내레이션 (영어) |
|---|---|---|---|---|
| 1 | 0:00–0:08 | 보드 전체 (상단 카드 4개 보이게) | 정지 | "Tokenized stocks on Base trade 24/7. Their reference price doesn't." |
| 2 | 0:08–0:20 | 보드 표 | 천천히 스크롤, "VS NAV" 열에 커서 | "StockGuard compares every Coinbase tokenized stock's NAV with its deepest Base DEX pool, every minute." |
| 3 | 0:20–0:28 | 상단 카드 "415 / 11" 확대 | ⌘ + 확대 | "415 are listed. Only 11 have a real Base pool today." |
| 4 | 0:28–0:50 | 가장 차이 큰 종목 클릭 → 오른쪽 상세 패널 | 그래프 → "What to watch" 순서로 커서 | "Here's the gap over 24 hours, and why it matters right now — market closed, thin pool, or a stale NAV." |
| 5 | 0:50–1:02 | 보드 하단 "Is this token the real one?" | 가짜 주소 붙여넣기 → Not official / 진짜 주소 → Official | "Paste any address. Official or not, in one click." |
| 6 | 1:02–1:15 | 텔레그램 채널 | 경보 메시지 1개, 복구 메시지 1개 | "A ±2% gap confirmed twice goes to a public alert channel — and a recovery message when it's over." |
| 7 | 1:15–1:25 | 아키텍처 그림 (README 다이어그램 캡처) | 정지 | "Now the part with no keeper bot." |
| 8 | 1:25–1:50 | 2분할: 왼쪽 터미널 `npm run drill -- --symbol AAPLc --bps 350` | 실행, 출력 1)이 뜰 때까지 | "This is a testnet fire drill with a synthetic price. The report emits a DepegAlert event on Base Sepolia…" |
| 9 | 1:50–2:05 | 오른쪽: Lasna 익스플로러 센티넬 tx | 클릭 | "…our Reactive contract on Lasna reacts to it…" |
| 10 | 2:05–2:25 | 오른쪽: Base Sepolia 콜백 tx → Logs 탭 `CircuitBreakerTriggered` | 로그 확대 | "…and calls the circuit breaker back on Base. Any protocol can read isHealthy() before lending or swapping." |
| 11 | 2:25–2:40 | 터미널 `curl -i localhost:8787/api/agent/risk?symbol=AAPLc` → 402 응답 | 402와 payment 헤더 강조 | "Agents get the same check for a tenth of a cent through x402. No API key." |
| 12 | 2:40–2:50 | 보드 화면 하단 고지 문구 + GitHub 저장소 | 정지 | "Read-only. No trading. Open source. Built in public." |

드릴은 녹화 중 콜백까지 1~3분 걸릴 수 있으니, 미리 실행해 둔 드릴의 tx 탭을 보여주고 터미널 실행 장면만 녹화해도 됩니다.
그 경우 자막에 "recorded earlier" 같은 거짓 연출 없이 그대로 "testnet fire drill"로 표기하면 충분합니다.

## X 게시물용 (Base 제출)

- 같은 영상을 X에 직접 업로드 (링크보다 노출이 큼). 게시물에 @buildonbase 태그 필수
- 썸네일이 되는 첫 프레임 = 장면 1 (보드 전체)
