# Optional local learned search / 선택형 로컬 의미 검색

## English

Aro works without a learned model. PostgreSQL exact-name, alias, metadata,
full-text and character matching remain available. To add learned passage
retrieval, configure a separately managed private embedding service. The app
image and installation archive do not contain model weights or llama.cpp.

The validated text-only configuration is EmbeddingGemma 2 Q8_0 with 768 finite,
normalized dimensions and mean pooling. Its index identity is
`eg2-2188ac1d-q8-mean-768-search-chunks-v3`; other weights, prompts, dimensions,
pooling or chunker versions must not contribute to this index.

| Material | Pin |
| --- | --- |
| llama.cpp | `78651c410dd8d97e3e22e533e0e7117889e3863a` (b11460) |
| GGUF repository revision | `bfcd298762cc34d0357ece5ebdd31791a3a374d8` |
| File | `embeddinggemma-2-Q8_0.gguf`, 309855456 bytes |
| SHA-256 | `2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135` |

Obtain the text weights from the pinned
[GGUF repository](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/tree/bfcd298762cc34d0357ece5ebdd31791a3a374d8)
and verify the checksum. Review the upstream model's Apache-2.0 terms and
[llama.cpp](https://github.com/ggml-org/llama.cpp/tree/78651c410dd8d97e3e22e533e0e7117889e3863a)
license/notices for separately distributed runtime materials.

Build the pinned CPU server on its native host:

```sh
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
git checkout 78651c410dd8d97e3e22e533e0e7117889e3863a
docker build -f .devops/cpu.Dockerfile --target server \
  --build-arg APP_VERSION=b11460 \
  --build-arg APP_REVISION=78651c410dd8d97e3e22e533e0e7117889e3863a \
  -t aro-embedding:eg2-b11460 .
```

The runtime was measured on ARM64 CPU with two threads, one slot and a 2-GiB
memory cap. That is not an AMD64 performance guarantee. Preserve the input and
resource bounds; the original larger inference graph exceeded this memory cap.

In the installation directory, create `compose.embedding.yml`:

```yaml
services:
  app:
    networks:
      - default
      - embeddings
  embedding:
    image: aro-embedding:eg2-b11460
    restart: unless-stopped
    cpus: 2.0
    mem_limit: 2g
    command: ["-m", "/models/embeddinggemma-2-Q8_0.gguf", "--embeddings",
      "--pooling", "mean", "--flash-attn", "on", "-t", "2", "-tb", "2",
      "-np", "1", "-c", "2048", "-b", "2048", "-ub", "1024",
      "--host", "0.0.0.0", "--port", "8080"]
    volumes:
      - ${MODEL_FILE:?Set the absolute path to the verified GGUF}:/models/embeddinggemma-2-Q8_0.gguf:ro
    networks:
      - embeddings
networks:
  default: {}
  embeddings:
    internal: true
```

Set `MODEL_FILE` to your verified GGUF path in the private Compose `.env`, and
set `EMBEDDING_BASE_URL=http://embedding:8080`. The base Compose forwards the
endpoint to the app. There is no published model port. A separate container
must use Docker service DNS, not `localhost` inside the app.

```sh
docker compose -f compose.yml -f compose.embedding.yml up -d --wait
docker compose -f compose.yml -f compose.embedding.yml exec -T app \
  bun -e 'const r=await fetch(process.env.EMBEDDING_BASE_URL+"/health"); console.log(r.status); if(!r.ok) process.exit(1)'
```

The health command must print `200`. Also verify model weights, vector dimensions
and normalization before using a different runtime. Retrieval requests use
`task: search result | query: ...` and `title: ... | text: ...` prompts.

Configured note titles, headings, passages and search queries are sent to this
endpoint. Use only a trusted private service; this transfer is independent of
chat/Jev enablement and consent. Clear `EMBEDDING_BASE_URL` to disable it.

Indexing is bounded, resumable and source-version checked. Saves never await
inference. Search reports disabled/unavailable/indexing/ready counts; a busy or
failed model preserves lexical search. Queries have a 1.5-second learned deadline,
so CPU-heavy or oversized queries may stay lexical-only. Passage bodies are
bounded to 512 UTF-8 bytes and total model input to 1024 bytes. Related-note
discovery can reuse fresh cached passage vectors without live inference.

Keep the runtime image and weights separately for restart/recovery. Database
backups contain model-tagged index state and passages. Restored or changed notes
are reused only when source identity matches. Source-checkout maintainers may
run `bun --no-env-file scripts/reindex-semantic.ts` with their normal private
database/endpoint configuration; this tool is not bundled in the app image.
Do not use a different model under the same index identity.

## 한국어

학습형 모델 없이도 정확한 이름, 별칭, 메타데이터, 전문 검색과 문자 기반 검색을
사용할 수 있습니다. 의미 검색을 쓰려면 별도로 관리하는 비공개 임베딩 서비스를
설정하세요. 앱 이미지와 설치 아카이브에는 모델 가중치나 llama.cpp가 없습니다.

검증된 설정은 위 표에 고정한 EmbeddingGemma 2 Q8_0, 768차원 정규화 벡터,
mean pooling입니다. 표의 런타임 커밋, 가중치 리비전, 파일 크기와 SHA-256을
확인하고 해당 모델과 런타임의 별도 라이선스 및 고지를 유지하세요.
위 명령으로 고정한 CPU 서버를 빌드하고 설치 디렉터리에
`compose.embedding.yml`을 만듭니다.

비공개 Compose `.env`에 검증한 GGUF의 절대 경로를 `MODEL_FILE`로 설정하고
`EMBEDDING_BASE_URL=http://embedding:8080`을 추가하세요. 기본 Compose가 이
주소를 앱에 전달합니다. 모델 포트는 공개하지 않으며 앱 컨테이너 안의
`localhost` 대신 Docker 서비스 이름을 사용합니다. 위 시작 명령과 health 확인
명령을 실행해 `200`을 확인하세요. ARM64에서 두 스레드, 한 슬롯, 메모리 2GiB,
context/batch 2048, microbatch 1024로 측정했으며 AMD64 성능은 보장하지 않습니다.

설정하면 노트 제목, 섹션 제목, 본문 조각과 검색어가 이 주소로 전송됩니다.
신뢰하는 비공개 서비스만 사용하세요. 이 전송은 채팅/Jev 사용 설정이나 동의와
별개입니다. 끄려면 `EMBEDDING_BASE_URL`을 비우세요.

인덱싱은 제한된 작업량으로 재개되며 최신 원문인지 확인합니다. 저장은 추론을
기다리지 않습니다. 검색 화면은 비활성/사용 불가/인덱싱 중/완료 상태와 개수를
표시하며 모델이 바쁘거나 실패해도 문자 기반 검색을 유지합니다. 학습형 검색
제한 시간은 1.5초이므로 무거운 검색은 문자 기반 결과로 돌아갈 수 있습니다.
본문 조각은 UTF-8 512바이트, 전체 모델 입력은 1024바이트 이내입니다.
관련 노트는 최신 조각 벡터를 추론 없이 재사용할 수 있습니다.

복구를 위해 런타임 이미지와 가중치를 별도로 보존하세요. DB 백업에는 모델별
인덱스 상태와 본문 조각이 포함됩니다. 복구하거나 수정한 노트는 원문 식별자가
맞을 때만 재사용합니다. 소스 체크아웃에서는 비공개 DB와 endpoint 설정을
사용해 `bun --no-env-file scripts/reindex-semantic.ts`를 실행할 수 있습니다.
이 도구는 앱 이미지에 포함되지 않습니다. 같은 인덱스 식별자로 다른 모델을
사용하지 마세요.
