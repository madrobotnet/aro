# 아로: 설치와 설정

아직 발행되지 않은 개발 소스의 이름은 아로입니다. 이 안내의 릴리스 명령은
`madrobotnet/aro`에서 새 아로 개발판이 아닌 발행된 이랑 2.3.2를 설치합니다.
발행된 이미지와 아카이브 이름, 기존 데이터베이스, 쿠키, 환경변수와 볼륨
식별자는 그대로 유지하세요.

[English](SETUP.md) · [한국어](SETUP.ko.md) · [한국어 README](../README.ko.md)

이 안내는 소유자 한 명이 직접 호스팅하는 아로 인스턴스를 다룹니다. 배포 구성은
Docker Compose 서비스 두 개(Next.js 앱과 Postgres 데이터베이스)와 실제로
마운트되는 데이터 볼륨 두 개입니다. 각 볼륨에는 이름이 지정됩니다.
설치할 호스트에는 Bun이나 Node가 **필요하지 않습니다**.
운영자용 스크립트는 선택한 앱 이미지 안에서 실행합니다.

구조는 [ARCHITECTURE.md](ARCHITECTURE.md), 유지관리자의 릴리스 절차와 공개 상태는
[RELEASING.md](RELEASING.md)를 참고하세요.

<a id="1-what-you-deploy"></a>
## 1. 배포 구성

`compose.yml`은 다음 서비스를 정의합니다.

| 서비스 | 이미지 | 설명 |
| --- | --- | --- |
| `app` | `${IRANG_IMAGE:-ghcr.io/madrobotnet/irang:2.3.2}` | 이미지만 선택하는 Compose 서비스입니다. Bun 기반 독립 실행형 Next.js 서버를 `nextjs`(UID/GID 1001)로 실행합니다. `127.0.0.1:${APP_PORT:-3000}:3000`을 통해 루프백에만 포트를 엽니다. Docker 상태 검사는 `/api/health`를 확인합니다. |
| `db` | `pgvector/pgvector:0.8.6-pg18` | 내부 전용이며 호스트 포트를 열지 않습니다. 상태 검사 명령은 `pg_isready -U postgres -d second_brain`이고, 앱은 통과할 때까지 기다립니다. **새** 데이터 볼륨에서는 Postgres 진입점이 `docker/postgres/production/01-app-role.sql`을 실행해 `pgcrypto`, `vector`, `pg_trgm` 확장과 권한이 제한된 앱 역할을 미리 만듭니다(4절). |

Compose는 이름이 지정된 볼륨에 프로젝트 이름을 접두사로 붙입니다. 기본 프로젝트
이름은 디렉터리 이름이므로, 새 `aro` 체크아웃에서는 `aro_app-data`가 됩니다.
기존 설치는 `irang_app-data` 또는 `second-brain_app-data`일 수 있습니다.
업그레이드할 때 원래 프로젝트 이름과 물리 볼륨을 유지하세요.

| 볼륨 | 마운트 위치 | 내용 |
| --- | --- | --- |
| `app-data` | `/app/.data`(앱 컨테이너) | 첨부파일(`.data/attachments`)과 계정 로그인 CLI의 자격 증명 저장소(`auth/codex`, `auth/google`). 소유 UID는 1001이며 `auth` 디렉터리 권한은 0700입니다. |
| `postgres-data` | `/var/lib/postgresql`(DB 컨테이너) | 노트, 인박스, 대화 스레드, 첨부파일 메타데이터, 세션, 저장된 AI 설정 등 모든 앱 데이터 |

Compose에는 이전 버전의 키 `second_brain_pg18`도 선언되어 있지만, 선택한 DB
볼륨 하나만 마운트됩니다. 이 이름들은 각 프로젝트에서 쓰는 논리 키이며,
프로젝트와 무관하게 고정된 전역 볼륨 이름이 아닙니다. 기존 물리 볼륨을 유지하는
방법은 10절에 있습니다.

릴리스 아카이브의 `app.image`는 `release.json`에 기록된
`ghcr.io/madrobotnet/irang:2.3.2@sha256:...`로 고정됩니다. 그 밖의 Compose
설정은 파싱한 값 기준으로 소스와 같습니다. Compose 옆에 상대 경로
`docker/postgres/production` 디렉터리를 함께 두세요. `compose.yml`만 내려받으면
필수 DB 초기화 스크립트가 빠집니다.

<a id="2-prerequisites"></a>
## 2. 사전 준비

- Docker Engine과 **Docker Compose 5.1.0 이상**이 필요합니다. CI는 Compose
  5.5.1을 고정해 사용합니다. 이 안내는 Linux arm64의 Docker 29 / Compose
  5.5.1 환경에서 검증했습니다.
- 이미지 대상 플랫폼은 **linux/amd64**, **linux/arm64**입니다. 선택한
  릴리스의 워크플로 기록에서 두 플랫폼의 네이티브 이미지, 비공개 다운로드,
  API, 데이터 유지, 정리 검증을 확인하세요([RELEASING.md](RELEASING.md)).
- POSIX 셸 명령은 Linux에서 검증했습니다. macOS와 Windows에서는 검증하지
  않았습니다. `127.0.0.1` 밖에서 접근할 수 있게 하려면 직접 관리하며 TLS
  종료를 담당하는 리버스 프록시가 필요합니다(6절).
- 아카이브 설치에는 `tar`, `sha256sum`, `jq`를 사용하며 예제는
  `gh release download`로 공개 릴리스 파일을 받습니다. 비공개 이미지에는
  별도의 레지스트리 인증이 필요합니다.
- 호스트의 Node나 Bun은 필요하지 않습니다. 운영자용 스크립트는 앱 이미지의
  `/app/scripts`에 들어 있습니다(3절). 개발에는 Bun 1.4.2가 필요하며,
  Node 22는 상위 프로젝트 CLI의 하위 프로세스 테스트 픽스처에만 필요합니다.

설치나 업그레이드 전에 `docker compose version`을 확인하세요. 2.38.2를
포함한 오래된 Compose 클라이언트는 사용하지 않는 조건부 기본값 안의 필수
변수까지 먼저 평가하므로, 올바른 현재 버전 또는 이전 버전 설정을 거부할 수
있습니다. Compose 5.1.0에는
[상위 프로젝트의 변수 보간 수정](https://github.com/compose-spec/compose-go/commit/ddb94f10f3a0751c628e24afd3cc436ad8d1c55a)이
포함되어 있습니다. 먼저 Compose 플러그인을 업데이트하세요. 기존 비밀번호를
다시 생성하거나 다른 데이터 볼륨을 선택해서 이 오류를 피하려고 해서는 안 됩니다.

<a id="3-step-1-select-the-image-and-generate-the-operator-env"></a>
## 3. 1단계: 이미지 선택과 운영자용 `.env` 생성

### 설치 아카이브

아래 아카이브 명령은 [RELEASING.md](RELEASING.md)의 검증을 마친 `v2.3.2`
릴리스가 있어야 사용할 수 있습니다. 소스와 릴리스 파일은 공개되어 있지만 GHCR
패키지는 비공개이며 이미지를 받으려면 접근 권한이 필요합니다. 빈 디렉터리에
모든 릴리스 파일을 내려받고, 체크섬을 확인한 다음 압축을 풉니다.

```sh
mkdir irang-release-2.3.2
cd irang-release-2.3.2
gh release download v2.3.2 --repo madrobotnet/aro
sha256sum --check SHA256SUMS
tar -xzf irang-2.3.2-install.tar.gz
cd irang
IRANG_IMAGE=$(jq -r .image release.json)
export IRANG_IMAGE
docker pull "$IRANG_IMAGE"
```

초기 설정 스크립트와 앱에는 이 다이제스트 참조를 똑같이 사용하세요. 아카이브의
Compose는 이미 이를 기본값으로 사용합니다. `.env`에 이전 `IRANG_IMAGE`
재정의가 있으면 지우거나 갱신하세요. 소스의 Compose는 읽기 쉬운 버전 태그
`ghcr.io/madrobotnet/irang:2.3.2`를 사용하며, 릴리스 정책상 이 태그의 내용은
바뀌지 않습니다.

비공개 이미지를 받으려면 패키지 읽기 권한이 있는 Docker 레지스트리 자격 증명이
필요합니다. GitHub CLI의 저장소 인증이 Docker 레지스트리 자격 증명을
대신하지는 않습니다. 네이티브 릴리스 작업은 각 작업의 토큰으로 비공개 이미지
다운로드를 검증합니다. 그 토큰을 호스트로 내보내지 마세요. 공개 소스나 릴리스
파일을 받는 것만으로 비공개 이미지 접근 권한이 생기지는 않습니다.

### 소스에서 직접 빌드

GHCR에 접근할 수 없다면 공개 소스를 로컬에서 빌드하세요. 먼저 검증된 릴리스
태그를 선택하세요. Compose에는 빌드 설정이 없습니다.

```sh
git clone --branch v2.3.2 --single-branch https://github.com/madrobotnet/aro.git
cd aro
docker build --build-arg VERSION=2.3.2 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t irang:local .
IRANG_IMAGE=irang:local
export IRANG_IMAGE
```

### 설치 환경 파일 생성

압축을 푼 `irang/` 디렉터리 또는 소스 체크아웃에서 선택한 이미지를 실행합니다.
Compose가 읽을 `./.env`를 새 무작위 비밀 값과 권한 `0600`으로 만들고, 설치
확인 코드를 발행된 2.3.2 이미지에서는 한 번 출력합니다.

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/install \
  "$IRANG_IMAGE" bun --no-env-file /app/scripts/setup-env.mjs /install/.env
```

출력:

```
Created /install/.env
Installation code: <64 hex chars>
Keep this code private. Enter it on /setup after starting the server.
```

개발 버전은 비밀 값을 출력하지 않습니다. 생성된 비공개 `.env`를 로컬에서
열어 `SETUP_TOKEN` 값을 `/setup`에 입력하세요. 파일이나 터미널 녹화는
공유하지 마세요. 개발판 [서버 설치 도구](INSTALL-SERVER.md)는 비공개
터미널에서만 `--token` 조회도 지원합니다. 출력이 없다는 이유로 새 토큰을
생성해 기존 값을 교체하지 마세요.

소스에서 빌드했다면 생성된 `.env`에 `IRANG_IMAGE=irang:local`을 추가하세요.
앞서 셸에서 설정한 환경변수는 새 세션에 유지되지 않습니다. 루프백 HTTP에서는
`.env`의 기존 `INSECURE_COOKIES=0` 줄을 `INSECURE_COOKIES=1`로 바꾸세요.
HTTPS에서는 `0`을 유지합니다. 한 명령에만 적용하지 말고 앱 시작 전에 파일에
설정하세요.

새 설치에서 Compose 명령을 처음 실행하기 전에, 개발용 환경변수가 셸에 남아
있는지 확인하세요. 확인 방법은 7절에 설명합니다.

생성된 파일에는 다음 값이 들어갑니다.

| 변수 | 값 | 용도 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | 다른 비밀 값과 겹치지 않는 무작위 16진수 64자 | 앱 DB 역할의 비밀번호. Compose가 `DATABASE_URL`에 넣고, DB 초기화 스크립트가 역할을 만들 때 사용합니다. |
| `POSTGRES_ADMIN_PASSWORD` | 다른 비밀 값과 겹치지 않는 무작위 16진수 64자 | DB 컨테이너의 `postgres` 슈퍼유저 비밀번호. 운영자 유지보수 전용이며 앱에는 전달하지 않습니다. |
| `SETUP_TOKEN` | 다른 비밀 값과 겹치지 않는 무작위 16진수 64자 | 최초 설정 마법사를 보호하는 설치 확인 코드 |
| `APP_PORT` | `3000` | 앱 서비스가 루프백에 여는 포트 |
| `INSECURE_COOKIES` | `0` | 세션 쿠키의 `Secure` 속성(6절) |
| `TRUSTED_PROXY_HOPS` | `1` | 클라이언트 IP를 판단할 때 신뢰하는 리버스 프록시 단계 수(6절) |

스크립트는 기존 `.env`를 덮어쓰지 않습니다. `.env`가 있으면 파일 생성 단계에서
멈추고 아무것도 바꾸지 않습니다.

직접 관리하는 환경 파일을 쓴다면 코드만 생성해 붙여 넣을 수 있습니다.

```sh
docker run --rm "$IRANG_IMAGE" bun --no-env-file /app/scripts/setup-token.mjs
# prints: SETUP_TOKEN=<64 hex chars>
```

새 설치에는 `POSTGRES_PASSWORD`, `POSTGRES_ADMIN_PASSWORD`, `SETUP_TOKEN`이
필요합니다. 기존 1.x 자격 증명 이름도 저장된 비밀번호를 바꾸지 않고 사용할 수
있지만, 데이터 볼륨을 명시적으로 선택해야 합니다(10절). 기존 설치에 `setup-env`를
실행하거나 업그레이드 중에 DB 비밀번호를 다시 생성하지 마세요.

**Windows 안내(미검증):** 아카이브를 푼 뒤 메타데이터를 읽고 초기 설정 파일을
생성하는 명령을 PowerShell로 옮기면 다음과 같습니다.

```powershell
$env:IRANG_IMAGE = (Get-Content ./release.json -Raw | ConvertFrom-Json).image
docker pull $env:IRANG_IMAGE
docker run --rm -v "${PWD}:/install" $env:IRANG_IMAGE bun --no-env-file /app/scripts/setup-env.mjs /install/.env
```

POSIX의 `--user "$(id -u):$(id -g)"` 매핑에 직접 대응하는 PowerShell 표현이
없어 생략했습니다. Docker Desktop의 파일 공유와 생성된 파일의 권한을 확인하세요.
Windows에서 실행해 본 명령은 아닙니다. 명령을 번역한 예시이지 검증된 설치
경로가 아닙니다.

<a id="4-step-2-start-the-selected-image"></a>
## 4. 2단계: 선택한 이미지 시작

내려받은 릴리스 이미지는 다음과 같이 시작합니다.

```sh
docker compose up -d --wait --wait-timeout 180
```

소스에서 빌드한 `irang:local` 이미지라면 3절에 따라 `.env`를 만들고
`IRANG_IMAGE=irang:local`을 추가한 뒤 실행합니다.

```sh
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180
```

Compose는 이미지만 선택하며 빌드하지 않습니다. `.env`에는 루프백 HTTP용
`INSECURE_COOKIES=1` 또는 HTTPS용 `0`을 유지하세요(6절). 먼저 DB 서비스의
상태 검사가 통과하고, 그다음 앱이 시작됩니다. 다음 명령으로 확인합니다.

```sh
curl -i http://127.0.0.1:3000/api/health     # expect 200 {"ok":true}
```

비어 있는 `postgres-data` 볼륨으로 **처음** 시작할 때 DB 진입점은 연결을
받기 전에 `docker/postgres/production/01-app-role.sql`을 실행합니다.
`pgcrypto`, `vector`, `pg_trgm` 확장을 미리 만들고, `POSTGRES_PASSWORD`로
로그인하는 앱 역할 `second_brain`을 생성합니다. 이 역할에는
`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`이 적용되며, `public`
스키마 안에서 사용하고 객체를 생성할 수 있지만 그 밖의 권한은 없습니다.
진입점 초기화 스크립트는 데이터 볼륨이 비었을 때만 실행되며, 기존 볼륨에서는
다시 실행되지 않습니다.

`.env`를 직접 편집해도 생성된 `POSTGRES_PASSWORD`(16진수 64자)는 유지하세요.
`DATABASE_URL`을 명시하면 그 값이 우선합니다. 비밀번호에 URL 특수문자가
있으면 퍼센트 인코딩한 URL을 사용하세요. 명시한 URL이 없으면 Compose는
`POSTGRES_APP_PASSWORD`가 있을 때 그 값을, 없을 때 `POSTGRES_PASSWORD`를
사용해 URL을 만듭니다.

앱과 DB 관리자의 자격 증명은 분리해야 합니다. 기본 앱 연결은 `second_brain`
역할을 사용합니다. 운영자가 지정하는 `DATABASE_URL`도 DB 관리자가 아닌 앱 역할을
사용해야 합니다. `postgres` 슈퍼유저와 `POSTGRES_ADMIN_PASSWORD`는 DB
컨테이너 안에서 운영자가 유지보수할 때만 사용합니다(예: 대화형 `psql` 세션).
`POSTGRES_ADMIN_PASSWORD`를 `DATABASE_URL`, 앱 환경변수 또는 앱 설정에
넣지 마세요.

<a id="5-step-3-first-run-wizard-at-setup"></a>
## 5. 3단계: `/setup`에서 최초 설정

`http://127.0.0.1:<APP_PORT>/setup`을 엽니다. 마법사에서 다음을 입력합니다.

1. **설치 확인 코드**: 운영자 `.env`의 `SETUP_TOKEN` 값입니다. 서버에서
   다이제스트를 상수 시간으로 비교하며, 서버가 브라우저에 다시 보내거나
   브라우저에 저장하지 않습니다. 링크나 URL에 넣지 마세요.
2. **로그인 비밀번호**: 12-512자로 두 번 입력합니다. 모든 기기에서 앱에
   로그인할 때 쓰는 비밀번호가 됩니다.
3. **AI 연결(선택)**: 채팅 AI와 Jev는 모두 기본적으로 *꺼져* 있습니다.
   나중에 설정에서 연결하거나 바꿀 수 있습니다(8절).

서버는 다음과 같이 동작합니다.

- 설치가 실제로 비어 있을 때만 공개 마법사를 사용할 수 있습니다. 환경변수에
  `AUTH_PASSWORD_HASH`가 있거나 사용자, 설치 설정, 노트, 인박스 항목, 대화
  스레드, 첨부파일 중 하나라도 있으면 마법사가 비활성화되고 `/setup`은
  `/login`으로 이동합니다.
- 첫 소유자 계정과 AI 설정은 advisory lock으로 보호한 하나의 DB 트랜잭션에서
  저장합니다. 트랜잭션 안에서 빈 상태인지 다시 확인하므로, 동시 제출 두 건이
  모두 서버 소유권을 얻을 수 없습니다. 그사이 데이터가 생긴 서버에서는
  HTTP 409로 거부합니다.
- 설치 확인 코드가 틀리면 HTTP 403으로 거부하고 아무것도 기록하지 않습니다.
- 성공하면 `/login`으로 이동합니다. 한 클라이언트 IP에서 로그인에 5번
  실패하면 해당 15분 구간의 남은 시간 동안 로그인이 제한됩니다.
  응답은 `retry-after`가 포함된 HTTP 429입니다.

<a id="6-cookies-http-vs-https-and-reverse-proxy-trust"></a>
## 6. 쿠키, HTTP·HTTPS, 리버스 프록시 신뢰

세션 쿠키(`sb_session`)와 제공자 로그인용 브라우저 쿠키(`sb_ai_auth`)에는
`HttpOnly`, `SameSite=Lax`가 적용됩니다. 프로덕션 빌드에서는
`INSECURE_COOKIES=1`이 아닌 한 `Secure` 속성도 켜집니다.

- **로컬 루프백 HTTP 확인:** 운영자 `.env`에 `INSECURE_COOKIES=1`을
  설정한 뒤 `docker compose up -d`로 앱 컨테이너를 다시 만드세요.
  루프백 HTTP 확인에만 사용합니다. 쿠키가 일반 HTTP로 전송되지만 앱이
  `127.0.0.1`에만 바인딩되므로 다른 컴퓨터에서는 접근할 수 없습니다.
- **공개 HTTPS:** 기본값인 `INSECURE_COOKIES=0`을 유지하세요. 같은
  호스트에서 루프백에 바인딩된 앱 앞에 TLS 종료 리버스 프록시를 둡니다.
  프록시는 `Host` 헤더를 바꾸지 않고 전달해야 합니다. 데이터를 변경하는
  API 요청은 요청의 `Origin`과 비교하므로, `Host`를 다시 쓰면 검사가
  실패합니다.

`TRUSTED_PROXY_HOPS`(기본값 `1`)는 수신한 `X-Forwarded-For` 목록에서 실제
클라이언트 IP로 사용할 항목을 정합니다. 먼저 빈 항목을 제외한 뒤, 1이면
남은 목록의 *마지막* 항목, 2이면 뒤에서 두 번째 항목을 사용합니다. 목록이
설정한 단계 수보다 짧으면 첫 항목을 사용하고, 목록이 비어 있을 때만
`X-Real-IP`로 대체합니다. 선택한 값이 IP 주소가 아니면 클라이언트 IP를
반환하지 않으며, 다른 항목이나 헤더를 대신 확인하지도 않습니다. 배포 시
앱으로 들어오는 연결은 여기에 설정한 프록시로 제한해야 합니다.

**Cloudflare 구성 주의:** 자체 리버스 프록시 앞에 Cloudflare가 있으면 앱이
받는 목록은 보통 `visitor, cloudflare-edge`입니다. 자체 프록시가 Cloudflare
엣지 주소를 덧붙이기 때문입니다. 기본값 `TRUSTED_PROXY_HOPS=1`은 실제
방문자가 아닌 엣지 주소를 선택하므로 모든 방문자에게 같은 로그인 제한이
적용됩니다. 방문자와 앱 사이에서 `X-Forwarded-For`에 주소를 덧붙이는
프록시 수로 `TRUSTED_PROXY_HOPS`를 설정하세요. Cloudflare와 자체 프록시
조합에서는 보통 `2`입니다. 프록시가 헤더를 덮어쓰지 않고 덧붙이도록
설정해야 합니다(예: nginx의 `proxy_add_x_forwarded_for`).

<a id="7-environment-files-what-goes-where"></a>
## 7. 환경 파일의 역할과 값 작성

환경 파일은 두 가지입니다. 해시 도구의 `--env` 모드는 큰따옴표로 감싸고
각 `$`를 `\$`로 이스케이프한 Argon2 할당문을 출력합니다.
두 dotenv 파일 중 어느 쪽에든 출력된 한 줄을 그대로 복사하세요.

| 파일 | 생성 방법 | 사용 주체 | 달러 기호 처리 |
| --- | --- | --- | --- |
| `.env`(설치 디렉터리) | 이미지의 `/app/scripts/setup-env.mjs` | Docker Compose(변수 보간과 앱 환경변수) | 출력된 큰따옴표와 `\$`를 유지합니다. 달러 기호를 두 개로 늘리지 않습니다. |
| `.env.local` | 직접 `cp .env.example .env.local` 실행 | 로컬 개발(`bun run dev`, Next가 로드) | 출력된 큰따옴표와 `\$`를 유지합니다. 이스케이프를 더 하거나 달러 기호를 두 개로 늘리지 않습니다. |

`.env.example`은 **로컬 개발**용 `.env.local`의 템플릿이며 Docker 배포 파일이
아닙니다. Docker의 `setup-env` 절차는 별도의 `.env`를 만들고 덮어쓰지 않습니다.

**셸에서 export한 환경변수가 운영자 파일보다 우선합니다.** Compose는 `.env`나
`--env-file`로 지정한 파일의 값보다 셸의 값을 먼저 사용합니다. 파일을 지정해도
실행한 셸의 환경변수는 그대로 적용됩니다. 개발용 `DATABASE_URL`이
`127.0.0.1:55432`를 가리키면 앱은 `db:5432` 대신 앱 컨테이너 자신의 루프백으로
접속하므로 health 응답이 HTTP 503이 되고 `ECONNREFUSED`가 발생할 수 있습니다.
상속된 `AUTH_PASSWORD_HASH`는 소유자 비밀번호보다 우선하고 최초 설정을
비활성화합니다.

**새 설치**에서는 개발 환경변수를 export하지 않은 셸을 사용하세요. 두 변수가
의도한 설치 설정이 아니라 셸에 남은 개발용 값인 경우에만, Compose 실행 전에
두 변수의 export를 해제하세요.

```sh
unset DATABASE_URL AUTH_PASSWORD_HASH
```

이 명령은 실행한 셸만 바꾸며 `.env`를 삭제하거나 편집하지 않습니다.
선택한 `IRANG_IMAGE`와 생성된 데이터베이스 자격 증명은 유지하세요.
기존 또는 레거시 설치에서는 의도한 `DATABASE_URL`, `AUTH_PASSWORD_HASH`,
원래 데이터베이스 비밀번호와 볼륨 선택을 보존해야 합니다. 셸 우선순위 문제를
해결하려고 자격 증명을 지우거나 운영자 파일을 다시 만들지 마세요.

복구 또는 마법사 도입 전 배포에서 쓰는 `AUTH_PASSWORD_HASH`는 다음과 같이
생성합니다(10절, 11절).

| 대상 | 명령 | 파일에 넣을 값 |
| --- | --- | --- |
| 로컬 개발 `.env.local` | `bun run hash-password` | `\$`를 포함한 큰따옴표 형식 `AUTH_PASSWORD_HASH="..."` 한 줄 |
| Compose `.env` | `docker compose exec app bun --no-env-file /app/scripts/hash-password.mjs --env` | `\$`를 포함한 큰따옴표 형식 `AUTH_PASSWORD_HASH="..."` 한 줄 |

앞뒤 큰따옴표와 출력에 포함된 `\$`를 유지하세요. Next와 Bun은 작은따옴표
안에서도 이스케이프하지 않은 달러 기호를 보간합니다. Compose도 이
큰따옴표와 이스케이프 형식을 올바르게 읽습니다. 이스케이프를 지우거나
추가하지 말고 달러 기호를 `$$`로 바꾸지 마세요. `docker compose config`
출력에서는 같은 달러 기호를 `$$`로 표현할 수 있습니다. Compose가 출력 YAML을
다시 읽을 때 같은 값을 얻도록 달러 기호를 이스케이프한 것입니다.
복사한 dotenv 값을 바꾸라는 뜻은 아닙니다.
해시 스크립트의 입력 프롬프트에는 입력한 비밀번호가 보이므로 개인 터미널에서
사용하세요.

`--env` 없이 실행하면 원시 PHC 해시만 출력합니다. Compose 밖에서
`docker run --env-file`에 전달할 파일에는 dotenv 따옴표와 이스케이프 없이
원시 값을 넣으세요. Docker는 그 값을 문자 그대로 읽습니다.

`.env`의 변수를 바꾸려면 파일을 편집하고 `docker compose up -d`를 실행하세요.
환경변수 변경은 컨테이너를 다시 만들어야 앱에 반영됩니다. 앱 UI의 설정 변경은
재시작 없이 바로 적용되지만 환경변수는 그렇지 않습니다. Compose는 아래의
지원되는 앱 변수만 명시적으로 전달하며, 운영자 `.env` 전체를 앱에 넣지
않습니다. 따라서 DB 관리자 비밀번호는 DB에만 전달됩니다. 첨부파일이나
자격 증명 디렉터리를 바꾸려면 마운트된 `/app/.data` 아래에 두거나 별도의
영속 볼륨을 사용해야 합니다.

로컬 개발이나 이전 설치 업그레이드에서 비밀번호에 특수문자가 포함된
`DATABASE_URL`이 필요하면 개발 환경의 `bun run database-url`로 만들 수 있습니다.
설치 환경에서는 선택한 이미지 안의 Bun이 운영자 파일을 읽도록 실행하세요.

```sh
docker run --rm -v "$PWD/.env":/install/.env:ro "$IRANG_IMAGE" \
  bun --env-file=/install/.env /app/scripts/build-database-url.mjs
```

두 명령 모두 `POSTGRES_APP_PASSWORD`를 읽어 퍼센트 인코딩하고 URL을
출력합니다. 이 변수는 필수입니다. 기본 사용자, 호스트, 포트, 데이터베이스는
각각 `second_brain`, `db`, `5432`, `second_brain`이며, 호스트·포트·데이터베이스를
선택 인수로 지정할 수 있습니다. `POSTGRES_APP_USER`로 사용자를 바꿀 수 있습니다.
출력에는 비밀번호가 들어 있으므로 공유 로그에 남기지 마세요.
`bun run seed`는 개발 DB에 예제 노트를 추가합니다.

### 런타임 환경변수

| 변수 | 사용 주체 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 앱(DB 계층) | 앱 비밀번호로 생성 | 명시적으로 지정한 퍼센트 인코딩 Postgres URL이 자동 생성 URL보다 우선합니다. |
| `SETUP_TOKEN` | 최초 설정 마법사 | `compose.yml`에서 필수 | `/setup` 보호용. 32-256자를 허용하며 생성 값은 16진수 64자입니다. |
| `AUTH_PASSWORD_HASH` | 로그인과 설정 상태 판별 | 비어 있음 | Argon2id PHC 해시. 설정하면 마법사에서 만든 소유자 비밀번호보다 우선하며 마법사를 계속 비활성화합니다. |
| `INSECURE_COOKIES` | 로그인과 제공자 Auth | `0` | `1`이면 쿠키의 `Secure` 속성을 끕니다(루프백 HTTP 전용). |
| `TRUSTED_PROXY_HOPS` | 클라이언트 IP 판별 | `1` | 신뢰하는 `X-Forwarded-For` 단계 수(6절) |
| `SESSION_TTL_DAYS` | 세션 | `30` | 세션 유지 기간(일) |
| `ATTACHMENTS_DIR` | 첨부파일 저장 | `.data/attachments`(앱 작업 디렉터리 기준 상대 경로) | 첨부파일 위치. Docker에서는 `app-data` 볼륨 안에 있습니다. |
| `APP_PORT` | `compose.yml` | `3000` | 루프백 호스트 포트 |
| `IRANG_IMAGE` | `compose.yml`만 사용 | 소스는 `ghcr.io/madrobotnet/irang:2.3.2`, 아카이브는 검증된 다이제스트 | 앱 이미지의 명시적 선택. 소스 빌드는 `irang:local`로 설정합니다. 앱에는 전달하지 않습니다. |
| `POSTGRES_PASSWORD` | `compose.yml` | 필수 | 현재 설치에서는 앱 역할 비밀번호. `POSTGRES_APP_PASSWORD`가 있는 이전 설치에서는 원래 관리자 비밀번호입니다. |
| `POSTGRES_ADMIN_PASSWORD` | `compose.yml`의 DB 서비스 | 현재 설치에서 필수 | 명시적 관리자 비밀번호. 이전 설치에서는 원래 `POSTGRES_PASSWORD`를 대신 사용합니다. |
| `POSTGRES_APP_PASSWORD` | `compose.yml`의 DB 서비스 | `POSTGRES_PASSWORD` | 이전 설치의 앱 비밀번호. 볼륨을 명시적으로 선택해야 하며 별도 앱 환경변수로 전달하지 않습니다. |
| `POSTGRES_DATA_VOLUME` | `compose.yml`의 DB 볼륨 마운트 | `postgres-data` | 기존 볼륨 키. 2.1 이상은 `postgres-data`, 1.x는 `second_brain_pg18`입니다. 원래 Compose 프로젝트 이름을 유지하세요. |
| `TYPESAFE_API_KEY` | Jev(이전 설정 대체 경로) | 비어 있음 | 저장된 설정이 없거나 Jev가 환경변수 관리 선택을 명시적으로 유지할 때 쓰는 API 키 |
| `TYPESAFE_JEV_MODEL` | Jev(이전 설정 대체 경로) | `jev-latest` | 환경변수 키를 사용할 때의 Jev 모델 |
| `TYPESAFE_BASE_URL` | Jev(이전 설정 대체 경로) | `https://api.typesafe.ai` | 이전 SDK 엔드포인트. UI는 `https://api.typesafe.ai` 또는 `https://openrouter.ai/api`의 키만 유지할 수 있습니다. |
| `CODEX_HOME` | Codex ChatGPT 인증 | 로컬은 `~/.codex`, Docker는 `/app/.data/auth/codex` | Codex `auth.json` 보관 디렉터리 |
| `CODEX_MODEL` | 채팅(환경변수 대체 경로 / 기본값) | `gpt-6.1-sol` | Codex ChatGPT 로그인으로 채팅할 때 쓰는 모델 |
| `CODEX_CHATGPT_BASE_URL` | Codex ChatGPT 통신 | `https://chatgpt.com/backend-api/codex` | 운영자가 관리하는 Codex 백엔드 엔드포인트 |
| `GEMINI_CLI_HOME` | Gemini CLI 인증 | 로컬은 미설정(Google CLI 로그인 불가), Docker는 `/app/.data/auth/google` | Gemini CLI가 OAuth 자격 증명을 저장하는 디렉터리. 절대 경로여야 합니다. |
| `EMBEDDING_BASE_URL` | 선택형 의미 검색 | 빈 값(비활성) | Compose가 전달하는 비공개 로컬 임베딩 주소. 채팅/Jev 동의와 별개입니다. |

<a id="8-ai-configuration-optional-per-provider"></a>
## 8. AI 설정(선택, 제공자별)

학습형 본문 조각 검색은 채팅/Jev 연결과 별개의 선택형 서비스입니다.
고정한 모델과 런타임, 비공개 네트워크, 자원 제한, 인덱싱과 복구는
[SEMANTIC-SEARCH.md](SEMANTIC-SEARCH.md)를 참고하세요. 앱 이미지에는 모델
가중치나 런타임이 없으며 주소를 설정하지 않으면 모델 없이 검색합니다.

아래 기능은 모두 선택 사항입니다. 수집, 노트, 편집, 검색, 그래프는 AI 연결 없이
모두 사용할 수 있습니다. 최초 설정 마법사 또는 앱의 **설정 → AI**에서 연결하며,
두 경로는 같은 설정을 저장합니다. 연결마다 이름을 붙이세요. 여러 연결을
저장한 뒤 채팅과 Jev에서 각각 하나씩 선택할 수 있습니다. 연결을 추가해도
자동으로 활성화되지 않습니다. 사용을 끄면 저장된 연결은 유지됩니다. 연결을
삭제하면 저장된 자격 증명이 지워지고, 사용 중이던 연결이면 비활성화됩니다.

### 채팅 AI

| 제공자 | API 키 방식 | 계정 로그인 방식 | 새 연결 권장 모델 |
| --- | --- | --- | --- |
| ChatGPT / OpenAI | 지원 | 앱 안에서 ChatGPT 기기 인증 | `gpt-6.1-sol` |
| Claude (Anthropic) | 지원 | **미지원**, API 키만 사용 | `claude-sonnet-5-5` |
| Gemini | 지원 | 앱 안에서 Google 브라우저 인증 코드 사용 | API: `gemini-3.8-flash`, Auth: `gemini-3.5-flash` |
| GitHub Copilot | Copilot API 토큰 | GitHub 기기 인증 | `gpt-6-luna` |
| OpenRouter | 지원 | 브라우저 PKCE 인증 | `openai/gpt-6.1-sol` |
| xAI / Grok | 지원 | xAI 기기 인증 | `grok-4.7` |
| OpenAI Compatible | 사용자 지정 키 또는 키 없음 명시 | 미지원 | 엔드포인트의 모델 ID 입력 |
| Anthropic Compatible | 사용자 지정 키 또는 키 없음 명시 | 미지원 | 엔드포인트의 모델 ID 입력 |

Auth 방식에는 제공자별 모델 목록이 최신순으로 표시됩니다. API 방식에서는
권장 모델과 함께 직접 편집할 수 있는 모델 ID를 제공합니다. 이미 저장한
모델 ID는 현재 권장 목록에 없더라도 바뀌지 않습니다. 모델 목록은 2026-09-29에
공식 자료로 확인했지만, 실제 사용 가능 여부는 계정·요금제·관리자 정책에
따라 결정됩니다.

ChatGPT 기기 인증은 공식 Codex 절차를 따릅니다. Gemini 브라우저 인증은
공식 Gemini CLI의 수동 PKCE 절차입니다. 필요한 `cloud-platform` 범위를
지원하지 않는 Google Device Flow는 사용하지 않습니다. 앱 이미지에는 공식
CLI(`@openai/codex@0.158.0`, `@google/gemini-cli@0.61.0`)가 들어 있으며,
Gemini 채팅은 여전히 CLI로 실행됩니다. 앱은 Gemini CLI의 공개 OAuth
클라이언트로 Google 인증 코드를 교환합니다. Google이 승인한 연동은 아닙니다.
계정 로그인을 선택하기 전에
[Gemini CLI 약관 및 개인정보 안내](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)를
읽으세요. CLI를 구동하는 서비스에 제3자가 직접 접근하는 것을 제한하는
조항도 포함되어 있습니다.

기존 서버 전체의 CLI 로그인도 호환됩니다. 이러한 이전 연결을 쓰는 운영자는
호스트 셸에서 다음 명령을 실행할 수 있습니다.

```sh
docker compose exec app codex login --device-auth
docker compose exec -e NO_BROWSER=true app gemini
```

CLI 자격 증명 파일은 영속 `app-data` 볼륨에 보관합니다.
`CODEX_HOME=/app/.data/auth/codex`,
`GEMINI_CLI_HOME=/app/.data/auth/google`이며 소유 UID는 1001입니다.
업그레이드하거나 컨테이너를 다시 만들어도 유지됩니다.

이전 CLI 연결은 CLI가 설치되어 있고 공식 자격 증명 파일이 비어 있지 않으며
읽을 수 있을 때 앱에서 "ready"로 표시됩니다. 파일이 준비됐다는
사실만으로 계정의 유효성, 이용 자격 또는 모델 권한이 입증되지는 않습니다.
첫 실제 요청에서만 유효성과 모델 권한을 확인할 수 있으며, 이후에도 계정
상태·요금제·결제 등 제공자의 통제를 받습니다.

### 브라우저 계정 로그인

ChatGPT, Gemini, Copilot, OpenRouter, xAI는 양식에서 Auth를 선택하고 연결을
시작합니다. 최초 설정 중이라면 먼저 설치 확인 코드를 입력하세요. 제공자의
로그인 페이지를 열고, 기기 코드를 요구하면 표시된 코드를 입력합니다.
원래 아로 탭으로 돌아와 인증 준비 완료가 표시되면 저장하세요.

- ChatGPT는 일회용 코드와 OpenAI 기기 확인 페이지 링크를 표시합니다.
  코드는 아로가 아닌 OpenAI 페이지에 입력합니다. ChatGPT 보안 설정 또는
  워크스페이스 권한에서 기기 코드 로그인을 허용해야 합니다.
- Gemini는 Google 로그인 페이지를 엽니다. Google이 제공한 인증 코드를
  원래 아로 양식에 복사해 제출하세요. 서버 터미널은 필요하지 않습니다.
  Auth 기본 모델 `gemini-3.5-flash`는 Gemini CLI의 기본 이용 등급을 따르며,
  계정에 권한이 있으면 3.8 Flash로 연결될 수 있습니다. 더 새 모델을
  선택한다고 그 모델의 접근 권한이 생기지는 않습니다.
- Copilot은 사용할 수 있는 Copilot 이용 자격이 필요합니다. API 방식에는
  임의의 GitHub 개인 액세스 토큰이 아니라 Copilot API 토큰을 넣어야 합니다.
  Enterprise 도메인과 Responses, Chat Completions, Messages 프로토콜을
  선택적으로 지정할 수 있습니다.
- OpenRouter 인증은 PKCE로 계속 사용할 수 있는 API 키를 발급합니다.
  ChatGPT, Claude 등의 구독을 OpenRouter로 옮겨 주지는 않습니다.
- xAI 계정 인증은 제공자의 기기 인증 절차와 갱신 토큰을 사용합니다.
  계정 이용 자격과 모델 접근 권한은 xAI가 결정합니다.
- 로그인 시도는 인증된 소유자 또는 설치 진행자에게 한정되며 시작한
  브라우저에 묶입니다. 준비된 시도는 연결을 저장하는 트랜잭션 안에서 한 번만
  사용하고, 저장에 실패하면 사용 처리도 되돌립니다. 최대 15분 뒤 만료됩니다.
  새 로그인을 시작할 때 만료된 기록을 지우며, 만료된 시도의 상태를 조회하면
  비공개 페이로드를 지웁니다.
- 저장된 계정 자격 증명은 서버에서 갱신합니다. Google 자격 증명은 채팅 중
  공식 Gemini CLI가 갱신하고, 그 밖의 지원 계정은 필요할 때 제공자 어댑터가
  갱신합니다. 접근이 취소되거나 갱신에 실패하면 설정에서 다시 연결해야 합니다.
  앱은 Copilot 모델 정책을 자동으로 활성화하지 않습니다.

### 사용자 지정 호환 엔드포인트

**OpenAI Compatible** 또는 **Anthropic Compatible**을 선택하고, 이름,
HTTP(S) 기본 URL, 모델 ID, API 키를 입력하거나 키 없는 엔드포인트임을
명시적으로 선택하세요.

| 입력 | 요청 목적지 |
| --- | --- |
| `https://gateway.example` + Chat Completions | `https://gateway.example/v1/chat/completions` |
| `https://gateway.example/custom/v1` + Responses | `https://gateway.example/custom/v1/responses` |
| `https://gateway.example/v1/messages` + Messages | 같은 URL. 접미사를 중복으로 붙이지 않습니다. |

OpenAI Compatible은 Chat Completions 또는 Responses를 지원하며,
Anthropic Compatible은 Messages를 사용합니다. 게이트웨이별 인증이 필요하면
추가 헤더를 지정할 수 있습니다. 헤더 이름은 대소문자를 구분하지 않으며
`Host`, `Cookie`, `Content-Length` 같은 전송 헤더는 바꿀 수 없습니다.
인증 헤더를 직접 제공하면 기본 키 헤더보다 우선합니다. 출력 토큰 제한은
선택 사항입니다.

URL에는 자격 증명, 쿼리 문자열, 프래그먼트를 포함할 수 없습니다. 게이트웨이
자격 증명은 API 키 필드나 추가 헤더에 넣으세요. 자격 증명을 동반한 요청은
리디렉션을 따라가지 않습니다. 제공자 또는 정규화된 엔드포인트를 바꾸면 이전
엔드포인트의 키나 추가 헤더를 재사용하지 않습니다. 새 키를 입력하거나 키
없음을 명시적으로 선택하고, 새 목적지에 필요한 헤더도 다시 입력하세요.

Docker에서 `localhost`는 앱 컨테이너를 뜻합니다. 접근 가능한 Compose
서비스 이름, LAN 주소 또는 Docker 호스트가 제공하는 `host.docker.internal`을
사용하세요. Linux Engine에서는 운영자가 앱 서비스에
`extra_hosts: ["host.docker.internal:host-gateway"]` 매핑을 추가해야 할 수
있습니다. 연결 대상 서버는 컨테이너에서 접근 가능한 인터페이스에 바인딩되어
있어야 합니다.

### Jev(인박스 정리 제안)

Jev는 채팅과 별도로 설정하는 선택 기능입니다. 인박스에 수집한 항목의 분류,
태그 제안, 중복 후보에만 쓰이며 채팅 AI가 없어도 작동하고 채팅 AI에 영향을 주지 않습니다.
TypeSafe SystemOne 엔드포인트를 통해 다음 두 제공자를 지원합니다.

| 제공자 | 엔드포인트 | 기본 모델 | 대체 모델 ID |
| --- | --- | --- | --- |
| TypeSafe(공식) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `jev-1.13.0` |
| OpenRouter | `https://openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest` | 라우터가 관리하며, 고정된 대체 모델은 권장하지 않습니다. |

구조화된 판단을 반환하는 모델과 위 모델 ID를 사용하세요. OpenRouter의 별도
"Jev Router" 제품은 다른 서비스이며 이 앱이 호출하는 대상이 아닙니다.
TypeSafe는 API 키를 사용합니다. OpenRouter는 API 키 또는 앞서 설명한
브라우저 계정 연결을 사용합니다. 활성 채팅 연결을 바꾸지 않고 Jev 프로필,
모델, 사용 여부를 바꿀 수 있습니다.

### 저장, 동의, 변경 동작

- 연결 프로필, API 키, 추가 헤더 값, 브라우저 Auth 자격 증명은 Postgres의
  `ai_connections`에 저장됩니다. `installation_settings.ai`에는 용도별
  선택 ID만 들어 있습니다. 비공개 서버 측 저장소이지만 **종단 간 암호화는
  아닙니다**. DB 백업도 그에 맞게 보호하세요(9절).
- 키와 설치 토큰은 브라우저로 다시 보내지 않습니다. 설정 API는 자격 증명
  유무와 헤더 이름 같은 가려진 메타데이터만 공개합니다. 저장된 키와 헤더는
  같은 프로필, 제공자, API 방식, 정규화된 엔드포인트일 때만 유지됩니다.
  헤더 값을 다시 읽을 수는 없습니다. 바꾸지 않은 헤더를 생략하면 유지하고,
  빈 헤더 객체를 보내면 지웁니다.
- 제공자 연결마다 데이터 전송 동의 체크박스를 명시적으로 선택해야 합니다.
  채팅 AI를 켜면 질문과 관련 노트 발췌를, Jev를 켜면 수집 내용과 최근 노트
  제목을 해당 제공자에게 보냅니다.
- 저장된 설정은 앱을 재시작하지 않아도 즉시 적용됩니다.
- 채팅과 Jev는 각각 저장된 프로필, 명시적 끄기, 이전 환경변수 설정 중 하나를
  독립적으로 선택합니다. 끄기를 선택하면 환경에 자격 증명이 있어도 사용하지 않습니다.
  비활성 프로필을 추가해도 어느 쪽의 선택도 바뀌지 않고 이전 동작도
  비활성화되지 않습니다.

<a id="9-data-backup-and-upgrades"></a>
## 9. 데이터, 백업, 업그레이드

개발 체크아웃의 [백업·격리 복원 검증 명령](BACKUP.ko.md)은 버전과 파일 체크섬을
확인하며 호스트 Node.js 22 이상이 필요합니다. 이미 발행된 2.3.2 아카이브에는
이 도구가 없습니다. 아래 수동 절차도 계속 사용할 수 있습니다.

노트를 영구 삭제하면 같은 DB 트랜잭션에 첨부파일 정리 작업을 기록합니다.
실제 파일은 트랜잭션 커밋 뒤에만 지웁니다. 저장소에 일시적으로 접근할 수
없어도 노트 삭제는 성공하며, 파일 키는 추적할 수 없는 상태로 방치되지 않고
비공개 재시도 대기열에 남습니다. 앱은 서버 시작 시와 이후의 영구 삭제 뒤에
대기 작업을 다시 시도합니다. 저장 디렉터리의 접근 권한을 복구하고 앱을
재시작하면 바로 재시도합니다. 지연 정리 로그에는 개수와 오류 코드만 남고,
첨부파일 이름이나 경로는 남지 않습니다. 휴지통으로 옮길 때는 파일을 지우지
않습니다.

**업그레이드 전에는 항상 백업하세요.** 이름이 지정된 두 볼륨(1절)에 모든 데이터가
있습니다. `postgres-data`에는 DB, `app-data`에는 첨부파일과 CLI 자격 증명이
들어 있습니다.

```sh
# 기존 설치 디렉터리에서 실행합니다. 백업은 그 밖에 보관합니다.
(
  set -eu
  umask 077
  mkdir -p "$HOME/second-brain-backups"
  BACKUP_DIR=$(mktemp -d "$HOME/second-brain-backups/backup.XXXXXX")
  cp .env "$BACKUP_DIR/operator.env"
  chmod 600 "$BACKUP_DIR/operator.env"
  APP_DATA_VOLUME=$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' \
    "$(docker compose ps -aq app)")
  trap 'docker compose start app' EXIT
  docker compose stop app
  docker compose exec -T db pg_dump --clean --if-exists \
    -U postgres second_brain > "$BACKUP_DIR/database.sql"
  docker run --rm -v "$APP_DATA_VOLUME:/data:ro" -v "$BACKUP_DIR:/backup" \
    alpine:3.23 sh -ec \
    'umask 077; tar czf /backup/app-data.tar.gz -C /data .; chown "$1:$2" /backup/app-data.tar.gz' \
    sh "$(id -u)" "$(id -g)"
  printf 'Backup directory: %s\n' "$BACKUP_DIR"
)
```

세 파일 모두 비공개 권한(0600)이며, DB와 첨부파일·인증 파일을 함께 복사하는
동안 앱은 멈춥니다. 백업 명령이 실패해도 앱을 다시 시작합니다. `operator.env`는
설치 비밀 값을 보존하며, `app-data.tar.gz`에는 CLI 자격 증명이 들어 있습니다.
둘 다 비밀번호처럼 보호하세요. 배포를 재현할 수 있도록 설치된
`release.json`/Compose 파일, 이미지 참조, 프로젝트 이름도 보관하세요.
운영자가 추가한 마운트는 별도로 기록해야 합니다. 위 명령은 기본
`/app/.data` 마운트를 백업합니다. 설정 > 내보내기의 Markdown zip에는
활성·보관 노트와 첨부파일이 있지만 설정, 세션, 대화, 휴지통은 없으므로
백업을 대신할 수 없습니다.

복원은 **별도의 비어 있는 설치**에서 진행하세요. 유지할 데이터가 있는 실행
중인 서버에 복원하면 안 됩니다. 3절에 따라 이미지를 내려받거나 소스에서
직접 빌드하고 `.env`를 생성하되, 앱은 아직 시작하지 마세요. 원래 설치가
실행 중이면 다른 `APP_PORT`와 Compose 프로젝트 이름을 지정합니다.
`BACKUP_DIR`을 출력된 백업 디렉터리로 설정하고 `.env`에 적절한 쿠키 모드를
유지하세요. SQL에는 정리 구문이 포함되어 있어 일치하는 객체를 대체합니다.
복원이 끝날 때까지 DB 이미지를 내려받고 DB만 시작합니다.

```sh
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180 db
docker compose exec -T db psql -v ON_ERROR_STOP=1 --single-transaction \
  -U postgres second_brain < "$BACKUP_DIR/database.sql"
docker compose create --no-build --pull never app
APP_DATA_VOLUME=$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' \
  "$(docker compose ps -aq app)")
docker run --rm -v "$APP_DATA_VOLUME:/data" -v "$BACKUP_DIR:/backup:ro" \
  alpine:3.23 tar xzf /backup/app-data.tar.gz -C /data
docker compose up -d --no-build --pull never --wait --wait-timeout 180
```

확장 메타데이터의 소유자가 `postgres`이므로 DB 관리자로 복원하세요.
덤프는 앱 테이블의 소유권을 `second_brain`으로 복원하고, 아카이브는 UID/GID
1001을 유지합니다. 새 설치를 사용하기 전에 노트와 첨부파일을 확인하세요.
덤프에는 세션도 들어 있습니다. 복구 뒤에 기존 세션을 유효하게 두고 싶지 않으면
설정에서 취소하세요.

**데이터를 보존하며 업그레이드하기:**

이미 2.1 이상의 `postgres-data`/`app-data` 볼륨을 쓰는 설치에서는 설치
디렉터리, 프로젝트 이름, 환경 파일, 물리 볼륨을 그대로 유지하세요.
`-p`, `COMPOSE_PROJECT_NAME`, `--project-directory`를 사용했다면 모든
업그레이드 명령에 같은 값을 사용합니다. 아카이브 설치는 별도의 다운로드
디렉터리에서 다음 아카이브의 체크섬을 검증합니다. `.env`는 바꾸지 않고,
SQL 디렉터리와 `release.json`을 포함한 배포 파일을 기존 설치 디렉터리에
복사하세요. 새 하위 `irang/` 디렉터리를 다른 Compose 프로젝트로 시작하면
안 됩니다.

그다음 기존 설치 디렉터리에서 실행합니다.

```sh
IRANG_IMAGE=$(jq -r .image release.json)
export IRANG_IMAGE
# .env의 이전 IRANG_IMAGE 재정의를 지우거나 같은 참조로 갱신합니다.
# 루프백 HTTP는 INSECURE_COOKIES=1, HTTPS는 0을 유지합니다.
docker pull "$IRANG_IMAGE"
docker compose up -d --wait --wait-timeout 180
```

소스 설치에서는 `.env`를 바꾸거나 프로젝트를 변경하지 않고 기존 체크아웃을
목표 버전으로 업데이트합니다. `VERSION`에는 그 체크아웃의 패키지 버전을
사용하세요. 이번 릴리스는 2.3.2입니다.

```sh
docker build --build-arg VERSION=2.3.2 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t irang:local .
IRANG_IMAGE=irang:local
export IRANG_IMAGE
# .env에 IRANG_IMAGE=irang:local과 올바른 쿠키 모드를 유지합니다.
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180
```

`docker compose up -d`는 바뀐 컨테이너를 다시 만들지만 **이름이 지정된 볼륨은
유지합니다**. `docker compose down`도 볼륨을 유지합니다. 데이터가 필요한
서버에서 `docker compose down -v` 또는 `--volumes`는 **절대** 실행하지
마세요. 두 데이터 볼륨을 삭제합니다. 업그레이드 뒤 DB를 처음 사용할 때
스키마 마이그레이션이 자동으로 실행되고 `schema_migrations`에 기록됩니다.
프로덕션 데이터를 유지해야 한다면 먼저 복원한 사본에서 업그레이드를 검증하세요.

<a id="10-existing-deployments"></a>
## 10. 기존 배포

### 1.x에서 업그레이드

이전 `docker-compose.yml`은 `second_brain_pg18` 볼륨 키와 다른 비밀번호
이름을 사용했습니다. 예전에는 `compose.yml`로만 바꾸면 비어 있는 새
`postgres-data` 볼륨이 선택됐습니다. 원래 볼륨은 지워지지 않았지만 앱이
비어 있는 것처럼 보일 수 있었습니다. 현재 호환 경로는
`POSTGRES_APP_PASSWORD`가 있으면 볼륨을 명시적으로 선택하도록 요구하며,
선택하지 않으면 리소스를 만들기 전에 실패합니다.

1. **새 버전을 내려받기 전에** DB와 첨부파일 디렉터리를 백업하세요.
   기존 Compose 프로젝트 이름과 DB 마운트를 기록합니다.
   `docker inspect --format '{{json .Mounts}}' "$(docker compose ps -q db)"`.
   실제 볼륨은 보통 `<project>_second_brain_pg18`입니다.
   `-p` 인수와 `COMPOSE_PROJECT_NAME` 값을 포함해 프로젝트 이름을 유지하세요.
2. 원래의 `DATABASE_URL`, `POSTGRES_APP_PASSWORD`, `POSTGRES_PASSWORD`,
   `AUTH_PASSWORD_HASH`를 유지하세요. `DATABASE_URL`은 퍼센트 인코딩한
   비밀번호까지 그대로 사용합니다. 비밀 값을 서로 바꾸거나 다시 생성하지
   마세요.
3. 같은 `.env`에 `POSTGRES_DATA_VOLUME=second_brain_pg18`을 추가하세요.
   실제로는 2.1 이상 설치인데 이전 앱 비밀번호 이름도 정의한 경우라면
   `postgres-data`를 명시적으로 선택합니다.
   `docker volume inspect <recorded-volume-name>`으로 선택한 물리 볼륨이
   이미 있는지 확인하세요.
4. 목표 릴리스 이미지를 선택해 내려받거나 3절에 따라 `irang:local`을
   빌드하세요. `SETUP_TOKEN`이 없다면
   `docker run --rm "$IRANG_IMAGE" bun --no-env-file /app/scripts/setup-token.mjs`를
   실행해 출력한 줄을 기존 `.env`에 복사합니다. 기존 로그인 해시나
   소유자가 있으면 이 토큰은 사용하지 않습니다. 이전 설치에는 새
   `POSTGRES_ADMIN_PASSWORD`가 필요하지 않습니다. 원래
   `POSTGRES_PASSWORD`가 관리자 비밀번호로 유지됩니다.
5. 새 앱을 시작하기 전에 이전 앱을 멈추세요. 같은 DB에 두 버전을 동시에
   연결하면 안 됩니다. 직접 지정한 첨부파일·인증 마운트도 유지하세요.
   이전 기본 Compose는 첨부파일을 영속 저장하지 않았습니다. 이전 앱
   컨테이너를 제거하거나 다시 만들기 **전에** 그 디렉터리를 밖으로
   복사하세요. 9절에 따라 새 `app-data` 볼륨 아래에 UID/GID 1001로
   복원합니다. DB를 보존한다고 첨부파일까지 보존된다고 생각해서는 안 됩니다.
6. 같은 프로젝트 이름과 기존 볼륨으로, 9절의 릴리스 또는 소스 절차에
   따라 선택한 이미지를 시작하세요. 백업을 지우기 전에 로그인, 기존 노트,
   기존 첨부파일을 확인합니다. 업그레이드 과정에서 `down -v`를 실행하지 마세요.

Compose는 현재 설치의 기본 볼륨을 `postgres-data`로 유지합니다. 기본값을
`second_brain_pg18`로 되돌리면 이미 생성된 2.1 이상 DB가 연결에서 빠집니다.
진입점의 비밀번호 설정은 초기화된 볼륨의 비밀번호를 바꾸지 않습니다.
호환 경로는 두 비밀번호 변수의 이름과 각 역할을 유지하며, 자격 증명을 초기화하거나
다른 클러스터로 데이터를 복사하지 않습니다.

이 경로는 PostgreSQL 18 데이터 배치용입니다. 이전 PostgreSQL 16 설치는
논리 덤프/복원이 필요합니다. PostgreSQL 16 데이터 디렉터리를 18에 마운트하면
안 됩니다. 검증은 현재 설정과 합성한 이전 PostgreSQL 18 설정, 컨테이너 재생성
뒤 데이터 유지까지 다뤘습니다. 실제 과거 1.x 바이너리에서의 업그레이드,
이전 첨부파일 이전, PostgreSQL 주 버전 이전은 실행하지 않았습니다.

### 기존 인증과 AI 설정

최초 설정 마법사 도입 전 배포도 다음 앱 규칙을 유지합니다.

- `AUTH_PASSWORD_HASH`가 있으면 마법사는 계속 비활성화되고(`/setup`은
  `/login`으로 이동), 환경변수 해시가 로그인에 우선합니다.
- 사용자나 보호 대상 데이터(노트, 인박스 항목, 대화 스레드, 첨부파일,
  설치 설정)가 하나라도 있으면 마찬가지로 공개 소유자 등록을 막습니다.
  이미 데이터가 있는 서버의 소유권을 마법사로 가져갈 수 없습니다.
- 환경변수 인증 배포에서도 Compose에는 `SETUP_TOKEN`이 필요하지만,
  설정 완료 뒤에는 사용하지 않습니다. DB 비밀 값은 위의 현재 또는
  이전 버전 체계를 따릅니다.
- Postgres 진입점 변수는 데이터 볼륨을 처음 초기화할 때만 적용됩니다.
  따라서 이전의 단일 비밀 값 구성으로 만든 배포는 원래 DB 역할과
  권한을 그대로 유지합니다. 새 제한 역할 초기화는 기존 볼륨에
  소급 적용되지 않으며 별도 작업도 필요하지 않습니다. 새 역할 구성을
  쓰려고 데이터 볼륨을 지우지 마세요. **새** 볼륨에서는
  `POSTGRES_PASSWORD`로 제한된 앱 역할을 만들고,
  `POSTGRES_ADMIN_PASSWORD`로 `postgres` 계정을 보호합니다(4절).
- UI에 설정을 **아직 저장하지 않았다면** 이전 환경변수 자격 증명이
  계속 작동합니다. `TYPESAFE_API_KEY`와 선택 변수 `TYPESAFE_BASE_URL`,
  `TYPESAFE_JEV_MODEL`은 Jev를 구동하고, ChatGPT 로그인용 Codex
  `auth.json`은 채팅을 구동합니다.
- UI의 설정 → AI에서 AI 설정을 저장한 뒤에는 명시적으로 끈 선택까지
  포함해 용도별 저장 설정이 우선합니다. 환경변수 선택을 유지하면 해당
  용도의 이전 동작도 유지됩니다(8절).
- 2.1에서 업그레이드하면 기존 인라인 채팅·Jev 자격 증명이 이름 있는
  프로필로 옮겨지며 모델과 활성 상태는 바뀌지 않습니다. 이 이전 과정은
  소유자 비밀번호나 CLI 자격 증명 파일을 바꾸지 않습니다.

<a id="11-recovery"></a>
## 11. 복구

**최초 설정 전에 설치 확인 코드를 잃어버린 경우.** 코드는 운영자 `.env`에
있습니다.

```sh
grep '^SETUP_TOKEN=' .env                  # 호스트에서
docker compose exec app printenv SETUP_TOKEN   # 실행 중인 컨테이너에서
```

`.env` 전체를 잃어버렸다면 비공개 백업에서 복원하세요. 한 번도 시작하지 않았고
DB 볼륨도 없는 설치라면 3절의 이미지 내부 `/app/scripts/setup-env.mjs`
명령을 다시 실행해 세 비밀 값을 만들 수 있습니다. PostgreSQL이 초기화된
뒤에는 `.env`의 비밀번호를 바꿔도 DB 역할의 비밀번호가 바뀌지 않습니다.
컨테이너를 다시 만들기 전에 원래 값을 복구하세요.

**비밀번호를 잊은 경우.** 1인용 앱이므로 공개 비밀번호 재설정 기능은 없습니다.
기존 해시 도구로 복구합니다.

1. `docker compose exec app bun --no-env-file /app/scripts/hash-password.mjs --env`로
   호스트에 Bun을 설치하지 않고 새 해시를 만듭니다. 터미널 프롬프트에
   입력한 비밀번호가 표시됩니다. 출력된 `\$`를 포함한 큰따옴표 형식의
   `AUTH_PASSWORD_HASH="..."` 한 줄을 운영자 `.env`에 그대로 복사하세요(7절).
   이스케이프를 더 하거나 달러 기호를 두 개로 늘리지 마세요.
2. `docker compose up -d`로 앱을 다시 만듭니다.
3. 새 비밀번호로 로그인하세요. 환경변수에 설정한 `AUTH_PASSWORD_HASH`는
   마법사에서 만든 소유자의 저장된 비밀번호보다 우선합니다. 이번 로그인에서
   DB의 소유자 행도 새 해시로 갱신됩니다.
4. 마법사로 만든 소유자라면 선택적으로 `AUTH_PASSWORD_HASH`를 지우고 앱을
   다시 만들 수 있습니다. 로그인은 갱신된 소유자 비밀번호를 사용하게 됩니다.
   마법사 도입 전 설치는 환경변수 해시를 유지해야 합니다.

로컬 개발에서는 `.env.local`과 큰따옴표로 감싼 `bun run hash-password`
출력으로 같은 복구를 진행하고, 이후 `bun run dev`를 다시 시작합니다.
저장된 소유자 비밀번호를 모르면서 환경변수 해시를 계속 유지하려면 4단계를
생략하면 됩니다.

<a id="12-development-commands-and-test-databases"></a>
## 12. 개발 명령과 테스트 데이터베이스

Bun 1.4.2와 Docker를 사용합니다. Node 22는 상위 프로젝트 계정 로그인 CLI의
하위 프로세스 테스트 픽스처에만 필요하며, 앱은 Bun으로 실행됩니다. 개발 DB는
`127.0.0.1:55432`의 별도 `second-brain-dev` Compose 프로젝트입니다.
`.env.example`을 `.env.local`로 복사한 뒤, `bun run hash-password`가 출력한
큰따옴표와 `\$`를 포함한 `AUTH_PASSWORD_HASH` 줄을 그대로 복사하세요.

| 명령 | 용도 |
| --- | --- |
| `bun run db:up` | 개발 DB 시작 |
| `bun run db:down` | 개발 DB 컨테이너와 볼륨 삭제. 프로덕션과 무관합니다. |
| `bun run seed` | 기존 데이터를 유지하면서 서로 연결된 한국어 예제 노트와 수집 항목 추가 |
| `bun run hash-password` | dotenv에 바로 넣을 큰따옴표 형식 `AUTH_PASSWORD_HASH="..."` 줄 출력. `\$`를 유지합니다. |
| `bun scripts/hash-password.mjs` | Docker `--env-file`용 원시 PHC 해시 출력 |
| `bun run setup-env` / `bun run setup-token` | 소스 체크아웃용 도구: `.env`를 덮어쓰지 않고 생성 / 새 `SETUP_TOKEN` 출력. 설치 이미지의 대응 명령은 3절에 있습니다. |
| `bun run database-url` | DB 비밀번호를 퍼센트 인코딩해 연결 URL 생성 |
| `bun run typecheck` / `bun run lint` / `bun test` / `bun run build` | 타입 검사, 린트, 테스트, 빌드 |

개발 초기화는 별도 `second_brain_test` DB를 만듭니다. 테스트는 그 DB에서만
데이터를 지우며 개발 노트장은 건드리지 않습니다. `TEST_DATABASE_URL`은
루프백의 `second_brain_test` 또는 `sb_test_<lane>` DB를 선택할 수 있습니다.
연결을 재정의하는 쿼리 매개변수는 거부합니다. 테스트 도우미는 데이터를
지우기 전에 초기화 상태, 캐시된 연결, 실제 DB 이름을 확인합니다.
테스트를 프로덕션에 연결하지 마세요.

`bun run db:down`은 로컬 개발 데이터를 삭제합니다. 프로덕션 Compose 프로젝트를
이름이 지정된 볼륨을 유지하면서 멈추려면 `-v` 없이 `docker compose down`을
사용하세요.

<a id="13-license"></a>
## 13. 라이선스

아로의 앱 코드는 [MIT](../LICENSE) 라이선스입니다. 이 라이선스가 의존성,
폰트, 런타임, 공식 계정 로그인 CLI, 운영체제 이미지, 제공자 서비스의
라이선스나 약관까지 바꾸지는 않습니다.
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)를 참고하세요.
이미지에는 수집한 라이선스 전문과 목록이 `/app/licenses`,
`/usr/share/irang/licenses`에 보관되며, 런타임과 운영체제가 제공한 고지도
유지됩니다. 목록이나 SBOM 검사를 통과해도 재배포 의무 검토를 대신할 수는
없습니다.
