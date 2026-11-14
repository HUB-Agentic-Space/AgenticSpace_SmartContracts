import { expect } from "chai";
import {
  isCreditOrQuotaError,
  isLocalChatModel,
  orderOllamaCandidates,
  parseParamSizeB,
  resolveOllamaBaseUrl,
  selectBestOllamaModel,
  OPENROUTER_FALLBACK_MODELS,
  type OllamaModelTag,
} from "../../scripts/utils/genai_client";

function tag(name: string, parameterSize: string, family = "granite", remoteHost?: string): OllamaModelTag {
  return {
    name,
    remote_host: remoteHost,
    details: { parameter_size: parameterSize, family, families: [family] },
  };
}

describe("genai_client — cadeia OpenRouter → Ollama", () => {
  describe("isCreditOrQuotaError", () => {
    it("reconhece HTTP 402 e 429 como erro de crédito/cota", () => {
      expect(isCreditOrQuotaError(402, "")).to.be.true;
      expect(isCreditOrQuotaError(429, "")).to.be.true;
    });

    it("reconhece erros de crédito/quota/rate-limit no corpo", () => {
      expect(isCreditOrQuotaError(400, "insufficient credits for request")).to.be.true;
      expect(isCreditOrQuotaError(200, "quota exceeded for the day")).to.be.true;
      expect(isCreditOrQuotaError(500, "Rate limit reached")).to.be.true;
    });

    it("não confunde falhas comuns com erro de crédito", () => {
      expect(isCreditOrQuotaError(500, "internal server error")).to.be.false;
      expect(isCreditOrQuotaError(404, "model not found")).to.be.false;
      expect(isCreditOrQuotaError(0, "network timeout")).to.be.false;
    });
  });

  describe("parseParamSizeB", () => {
    it("converte sufixos B/M/T para bilhões", () => {
      expect(parseParamSizeB("32.2B")).to.be.closeTo(32.2, 1e-9);
      expect(parseParamSizeB("475.29M")).to.be.closeTo(0.47529, 1e-9);
      expect(parseParamSizeB("1.6B")).to.be.closeTo(1.6, 1e-9);
      expect(parseParamSizeB("2T")).to.be.closeTo(2000, 1e-9);
    });

    it("retorna 0 para formatos ausentes ou inválidos", () => {
      expect(parseParamSizeB(undefined)).to.equal(0);
      expect(parseParamSizeB("")).to.equal(0);
      expect(parseParamSizeB("abc")).to.equal(0);
    });
  });

  describe("isLocalChatModel", () => {
    it("exclui modelos remotos (remote_host) e de embedding", () => {
      expect(isLocalChatModel(tag("glm-5:cloud", "30B", "glm", "ollama.com"))).to.be.false;
      expect(isLocalChatModel(tag("nomic-embed-text:latest", "137M", "nomic-bert"))).to.be.false;
      expect(isLocalChatModel(tag("embeddinggemma:latest", "308M", "gemma"))).to.be.false;
      expect(isLocalChatModel(tag("granite4:small-h", "32.2B", "granite"))).to.be.true;
    });
  });

  describe("selectBestOllamaModel", () => {
    it("escolhe o maior modelo de chat local", () => {
      const tags = [
        tag("qwen2.5:14b", "14.8B", "qwen2"),
        tag("granite4:small-h", "32.2B", "granite"),
        tag("glm-4.7-flash:latest", "29.9B", "glm"),
        tag("nomic-embed-text:latest", "137M", "nomic-bert"),
        tag("glm-5:cloud", "480B", "glm", "ollama.com"),
      ];
      expect(selectBestOllamaModel(tags)?.name).to.equal("granite4:small-h");
    });

    it("retorna null quando só há embeddings e remotos", () => {
      const tags = [
        tag("nomic-embed-text:latest", "137M", "nomic-bert"),
        tag("glm-5:cloud", "480B", "glm", "ollama.com"),
      ];
      expect(selectBestOllamaModel(tags)).to.be.null;
    });
  });

  describe("orderOllamaCandidates", () => {
    const tags = [
      tag("qwen2.5:14b", "14.8B", "qwen2"),
      tag("granite4:small-h", "32.2B", "granite"),
      tag("glm-4.7-flash:latest", "29.9B", "glm"),
    ];

    it("coloca o melhor modelo local primeiro, mesmo com OLLAMA_MODEL definido", () => {
      const ordered = orderOllamaCandidates(tags, "qwen2.5:14b");
      expect(ordered[0]).to.equal("granite4:small-h");
      expect(ordered[1]).to.equal("qwen2.5:14b");
      expect(ordered).to.have.length(3);
    });

    it("ignora OLLAMA_MODEL não instalado e deduplica", () => {
      const ordered = orderOllamaCandidates(tags, "modelo-inexistente:1b");
      expect(ordered).to.deep.equal(["granite4:small-h", "glm-4.7-flash:latest", "qwen2.5:14b"]);
    });

    it("retorna vazio quando nenhum modelo de chat está instalado", () => {
      expect(orderOllamaCandidates([tag("glm-5:cloud", "480B", "glm", "ollama.com")])).to.deep.equal([]);
    });
  });

  describe("resolveOllamaBaseUrl", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of ["OLLAMA_BASE_URL", "OLLAMA_URL"]) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of ["OLLAMA_BASE_URL", "OLLAMA_URL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("usa localhost por padrão", () => {
      expect(resolveOllamaBaseUrl()).to.equal("http://localhost:11434");
    });

    it("prefere OLLAMA_BASE_URL; OLLAMA_URL é alias", () => {
      process.env.OLLAMA_URL = "http://ollama.local:11434/";
      expect(resolveOllamaBaseUrl()).to.equal("http://ollama.local:11434");
      process.env.OLLAMA_BASE_URL = "http://custom:11434/";
      expect(resolveOllamaBaseUrl()).to.equal("http://custom:11434");
    });
  });

  describe("OPENROUTER_FALLBACK_MODELS", () => {
    it("começa pelo roteador free e termina no DeepSeek pago", () => {
      expect(OPENROUTER_FALLBACK_MODELS[0]).to.equal("openrouter/free");
      expect(OPENROUTER_FALLBACK_MODELS[OPENROUTER_FALLBACK_MODELS.length - 1]).to.equal("deepseek/deepseek-r1-0528");
    });

    it("inclui os modelos free solicitados (Nemotron, ERNIE, Ling)", () => {
      const joined = OPENROUTER_FALLBACK_MODELS.join(",");
      expect(joined).to.contain("nvidia/nemotron-3-ultra-550b-a55b:free");
      expect(joined).to.contain("nvidia/nemotron-3.5-lightning:free");
      expect(joined).to.contain("baidu/ernie-5.5-flash-preview:free");
      expect(joined).to.contain("inclusionai/ling-3.2-flash:free");
    });
  });
});
