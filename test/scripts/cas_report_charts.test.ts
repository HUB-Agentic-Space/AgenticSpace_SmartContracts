import { expect } from "chai";
import {
  WHALE_DEFAULT_PCT,
  WHALE_FILTER_JS,
  WHALE_THRESHOLDS,
  buildPieData,
  buildWhaleThresholdSelect,
  displayAccountName,
  formatTerm,
  groupTail,
  lastMovements,
  manipulationSignalTooltip,
  safeJsonForScript,
  whaleMinThreshold,
  type NodeStatsMap,
  type PieAlert,
  type PieHolderInfo,
  type PieLabelInfo,
  type PieTransfer,
  type RankedAccount,
} from "../../scripts/utils/cas_report_charts";

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

const noAnon = (): string | undefined => undefined;
const emptyLabels = new Map<string, PieLabelInfo>();
const emptyAlerts = new Map<string, PieAlert[]>();
const noStats: NodeStatsMap = new Map();
const noBalances = new Map<string, { balance: bigint; pct: number }>();

function acc(share: number, seed: number): RankedAccount {
  return { address: `0x${seed.toString(16).padStart(40, "0")}`, share };
}

describe("cas_report_charts — pizzas e tooltips compartilhados", () => {
  describe("groupTail", () => {
    it("agrupa o restante quando a soma residual fica em 10% ou menos", () => {
      const accounts = [acc(30, 1), acc(25, 2), acc(20, 3), acc(15, 4), acc(10, 5)];
      const { individuals, grouped } = groupTail(accounts);
      expect(individuals.map((a) => a.share)).to.deep.equal([30, 25, 20, 15]);
      expect(grouped.map((a) => a.share)).to.deep.equal([10]);
    });

    it("agrupa tudo quando a soma total já não passa de 10%", () => {
      const accounts = [acc(4, 1), acc(3, 2), acc(2, 3), acc(1, 4)];
      const { individuals, grouped } = groupTail(accounts);
      expect(individuals).to.have.length(0);
      expect(grouped).to.have.length(4);
    });

    it("não agrupa nada quando uma única conta detém 100%", () => {
      const { individuals, grouped } = groupTail([acc(100, 1)]);
      expect(individuals).to.have.length(1);
      expect(grouped).to.have.length(0);
    });

    it("respeita um teto customizado", () => {
      const accounts = [acc(50, 1), acc(30, 2), acc(20, 3)];
      const { individuals, grouped } = groupTail(accounts, 30);
      // 100>30→tira 50 (resta 50) →50>30→tira 30 (resta 20) →20<=30 para
      expect(individuals.map((a) => a.share)).to.deep.equal([50, 30]);
      expect(grouped.map((a) => a.share)).to.deep.equal([20]);
    });
  });

  describe("buildPieData", () => {
    const holders: PieHolderInfo[] = [
      { address: A, balance: 900_000n * 10n ** 18n, pct: 90 },
      { address: B, balance: 60_000n * 10n ** 18n, pct: 6 },
      { address: C, balance: 40_000n * 10n ** 18n, pct: 4 },
    ];
    const transfers: PieTransfer[] = [
      { hash: "0xhash1", from: ZERO, to: A, value: (900_000n * 10n ** 18n).toString(), timeStamp: "1700000000", blockNumber: "1" },
      { hash: "0xhash2", from: A, to: B, value: (10_000n * 10n ** 18n).toString(), timeStamp: "1700000100", blockNumber: "2" },
      { hash: "0xhash3", from: B, to: C, value: (5_000n * 10n ** 18n).toString(), timeStamp: "1700000200", blockNumber: "3" },
    ];
    const nodeStats: NodeStatsMap = new Map([
      [ZERO, { sent: 1, received: 0, volume: 900_000 }],
      [A, { sent: 1, received: 1, volume: 910_000 }],
      [B, { sent: 1, received: 1, volume: 15_000 }],
      [C, { sent: 0, received: 1, volume: 5_000 }],
    ]);
    const balances = new Map(holders.map((h) => [h.address, { balance: h.balance, pct: h.pct }]));
    const totalMovements = [...nodeStats.entries()]
      .filter(([a]) => a !== ZERO)
      .reduce((s, [, st]) => s + st.sent + st.received, 0);

    it("cria fatia 'Outras contas' quando a cauda não passa de 10%", () => {
      const pie = buildPieData(transfers, holders, nodeStats, emptyLabels, noAnon, emptyAlerts, balances, totalMovements);
      const others = pie.holders.find((s) => s.label.startsWith("Outras contas"));
      expect(others, "fatia agrupada deve existir").to.exist;
      expect(others!.share).to.be.closeTo(10, 0.01);
      expect(others!.tooltipHtml).to.contain("Outras contas (2)");
    });

    it("exclui o endereço zero da pizza de movimentadores", () => {
      const pie = buildPieData(transfers, holders, nodeStats, emptyLabels, noAnon, emptyAlerts, balances, totalMovements);
      for (const slice of pie.movers) {
        expect(slice.label).to.not.contain("endereço zero");
        expect(slice.tooltipHtml).to.not.contain(ZERO);
      }
    });

    it("cada fatia carrega tooltipHtml não vazio", () => {
      const pie = buildPieData(transfers, holders, nodeStats, emptyLabels, noAnon, emptyAlerts, balances, totalMovements);
      for (const slice of [...pie.holders, ...pie.movers]) {
        expect(slice.tooltipHtml.length).to.be.greaterThan(0);
      }
    });
  });

  describe("lastMovements", () => {
    const transfers: PieTransfer[] = [
      { hash: "0xa1", from: A, to: B, value: (100n * 10n ** 18n).toString(), timeStamp: "100", blockNumber: "1" },
      { hash: "0xa2", from: C, to: A, value: (50n * 10n ** 18n).toString(), timeStamp: "200", blockNumber: "2" },
      { hash: "0xa3", from: B, to: C, value: (25n * 10n ** 18n).toString(), timeStamp: "300", blockNumber: "3" },
    ];

    it("retorna movimentações da conta ordenadas da mais recente", () => {
      const movs = lastMovements(A, transfers);
      expect(movs).to.have.length(2);
      expect(movs[0].hash).to.equal("0xa2");
      expect(movs[0].direction).to.equal("in");
      expect(movs[1].direction).to.equal("out");
    });

    it("marca mint corretamente a partir do endereço zero", () => {
      const mint: PieTransfer = { hash: "0xm", from: ZERO, to: A, value: "1", timeStamp: "400", blockNumber: "4" };
      const movs = lastMovements(A, [mint]);
      expect(movs[0].direction).to.equal("in");
      expect(movs[0].counterparty).to.equal(ZERO.toLowerCase());
    });
  });

  describe("displayAccountName / formatTerm", () => {
    it("prefere nome anônimo quando fornecido", () => {
      const labels = new Map<string, PieLabelInfo>([
        [A, { label: "Deployer", isInfra: true, isContract: false, type: "wallet", asset: "CAS", observation: "" }],
      ]);
      expect(displayAccountName(A, labels, () => "Anon 1")).to.equal("Anon 1");
      expect(displayAccountName(A, labels, noAnon)).to.equal("Deployer");
    });

    it("formatTerm gera span com descrição para termos conhecidos", () => {
      const html = formatTerm("wash_trading");
      expect(html).to.contain("class=\"term\"");
      expect(html).to.contain("Wash Trading");
      expect(html).to.contain("title=");
      expect(formatTerm("tipo_desconhecido")).to.equal("tipo_desconhecido");
    });
  });

  describe("safeJsonForScript", () => {
    it("escapa '<' para impedir quebra da tag script por conteúdo externo", () => {
      const json = safeJsonForScript({ evil: "</script><script>alert(1)</script>" });
      expect(json).to.not.contain("</script>");
      expect(json).to.contain("\\u003c");
      expect(JSON.parse(json).evil).to.contain("</script>");
    });
  });

  describe("manipulationSignalTooltip", () => {
    const signal = {
      type: "wash_trading",
      severity: "ALTO" as const,
      start: 1700000000,
      end: 1700003600,
      addresses: [A, B],
      volumeCas: 12_345.67,
      txCount: 42,
      evidence: "Mesmos endereços trocando CAS entre si em janela curta.",
      metadata: { cycles: 7 },
    };

    it("inclui tipo legível, severidade, período, endereços e evidência", () => {
      const html = manipulationSignalTooltip(signal, emptyLabels, noAnon);
      expect(html).to.contain("Wash Trading");
      expect(html).to.contain("ALTO");
      expect(html).to.contain("UTC");
      expect(html).to.contain("polygonscan.com/address/");
      expect(html).to.contain("12.345,67");
      expect(html).to.contain("Mesmos endereços");
      expect(html).to.contain("cycles");
    });

    it("em modo anônimo substitui endereços por identidades Anon N", () => {
      const anonFor = (a: string) => (a === A ? "Anon 1" : a === B ? "Anon 2" : undefined);
      const html = manipulationSignalTooltip(signal, emptyLabels, anonFor);
      expect(html).to.contain("Anon 1");
      expect(html).to.contain("Anon 2");
      expect(html).to.not.contain("polygonscan.com/address/");
    });
  });

  describe("whale threshold combobox", () => {
    it("WHALE_THRESHOLDS cobre 5–30% e default é o menor", () => {
      expect(WHALE_THRESHOLDS).to.deep.equal([5, 10, 15, 20, 30]);
      expect(WHALE_DEFAULT_PCT).to.equal(5);
      expect(whaleMinThreshold()).to.equal(5);
    });

    it("buildWhaleThresholdSelect renderiza opções com default selecionado", () => {
      const html = buildWhaleThresholdSelect("whale-threshold", { tableId: "whale-tbody", countId: "whale-count" });
      expect(html).to.contain('id="whale-threshold"');
      expect(html).to.contain('data-table="#whale-tbody"');
      expect(html).to.contain('data-count-id="whale-count"');
      expect(html).to.contain('<option value="5" selected>5%</option>');
      expect(html).to.contain('<option value="30">30%</option>');
      expect(html.match(/<option/g)).to.have.length(5);
    });

    it("buildWhaleThresholdSelect honra defaultPct customizado", () => {
      const html = buildWhaleThresholdSelect("s", { tableId: "t", defaultPct: 20 });
      expect(html).to.contain('<option value="20" selected>20%</option>');
      expect(html).to.not.contain('value="5" selected');
    });

    it("buildWhaleThresholdSelect escapa ids no HTML", () => {
      const html = buildWhaleThresholdSelect('"><x>', { tableId: '"><y>' });
      expect(html).to.not.contain('"><x>');
      expect(html).to.not.contain('"><y>');
    });

    it("WHALE_FILTER_JS aplica regra estritamente maior e placeholder", () => {
      expect(WHALE_FILTER_JS).to.contain("pct > min");
      expect(WHALE_FILTER_JS).to.contain("data-whale-empty");
      expect(WHALE_FILTER_JS).to.contain("data-count-id");
      expect(WHALE_FILTER_JS).to.contain("data-whale-pct");
    });
  });
});
