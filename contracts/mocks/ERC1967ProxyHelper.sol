// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

// Author:  Carlos Delfino
// Email:   consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490

// Helper exclusivo para testes: importar o ERC1967Proxy da OpenZeppelin faz
// o artifact ficar disponivel em artifacts/ para instanciar proxies UUPS de
// bytecodes externos (ex.: CASTokenV2 do branch release/cas-v2, testado
// como fixture real em test/bridge/CASOFT.test.ts).
// solhint-disable-next-line no-unused-import
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
