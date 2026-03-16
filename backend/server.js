require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.get("/cadastro.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "cadastro.html"));
});

app.get("/cliente.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "cliente.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || "atendeplus_saas_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "..", "database", "saas.json");
const SESSIONS_PATH = path.join(__dirname, "..", "sessions");

// ===== util diretórios =====
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ===== util banco =====
function getInitialDB() {
  const senhaHashAdmin = bcrypt.hashSync("123456", 10);

  return {
    superAdmin: {
      email: "admin@atendeplus.com",
      senhaHash: senhaHashAdmin
    },
    usuarios: [],
    empresas: [],
    sessoesWhatsapp: []
  };
}

function ensureDB() {
  ensureDir(path.dirname(DB_PATH));
  ensureDir(SESSIONS_PATH);

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(getInitialDB(), null, 2), "utf-8");
    return;
  }

  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    let changed = false;

    if (!db.superAdmin || typeof db.superAdmin !== "object") {
      db.superAdmin = getInitialDB().superAdmin;
      changed = true;
    }

    if (!db.superAdmin.email) {
      db.superAdmin.email = "admin@atendeplus.com";
      changed = true;
    }

    if (!db.superAdmin.senhaHash) {
      db.superAdmin.senhaHash = bcrypt.hashSync("123456", 10);
      changed = true;
    }

    if (!Array.isArray(db.usuarios)) {
      db.usuarios = [];
      changed = true;
    }

    if (!Array.isArray(db.empresas)) {
      db.empresas = [];
      changed = true;
    }

    if (!Array.isArray(db.sessoesWhatsapp)) {
      db.sessoesWhatsapp = [];
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    }
  } catch (error) {
    console.error("Erro ao validar saas.json. Verifique se o JSON está válido.");
    throw error;
  }
}

function readDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function formatDate() {
  return new Date().toISOString();
}

function getEmpresaById(empresaId) {
  const db = readDB();
  return db.empresas.find((e) => e.id === empresaId) || null;
}

function getEmpresaBySlug(slug) {
  const db = readDB();
  return db.empresas.find((e) => e.slug === slug) || null;
}

// ===== auth =====
function authMiddleware(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ ok: false, message: "Não autenticado." });
}

function superAdminMiddleware(req, res, next) {
  if (req.session?.user?.tipo === "super_admin") return next();
  return res.status(403).json({ ok: false, message: "Acesso negado." });
}

function clienteMiddleware(req, res, next) {
  if (req.session?.user?.tipo === "cliente") return next();
  return res.status(403).json({ ok: false, message: "Acesso negado." });
}

// ===== whatsapp manager =====
const whatsappClients = new Map();
/*
slug => {
  client,
  status,
  qr,
  lastError
}
*/

function getOrCreateSessionRecord(empresa) {
  const db = readDB();
  let record = db.sessoesWhatsapp.find((s) => s.empresaId === empresa.id);

  if (!record) {
    record = {
      empresaId: empresa.id,
      clientId: empresa.slug,
      status: "desconectado",
      qr: "",
      lastError: "",
      atualizadoEm: formatDate()
    };
    db.sessoesWhatsapp.push(record);
    writeDB(db);
  }

  return record;
}

function updateSessionRecord(empresaId, updates) {
  const db = readDB();
  const record = db.sessoesWhatsapp.find((s) => s.empresaId === empresaId);

  if (!record) return;

  Object.assign(record, updates, { atualizadoEm: formatDate() });
  writeDB(db);
}

async function initWhatsAppForEmpresa(empresa) {
  if (!empresa || !empresa.slug) {
    throw new Error("Empresa inválida.");
  }

  if (whatsappClients.has(empresa.slug)) {
    return whatsappClients.get(empresa.slug);
  }

  getOrCreateSessionRecord(empresa);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: empresa.slug,
      dataPath: SESSIONS_PATH
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  });

  const state = {
    client,
    status: "iniciando",
    qr: "",
    lastError: ""
  };

  whatsappClients.set(empresa.slug, state);

  updateSessionRecord(empresa.id, {
    status: "iniciando",
    qr: "",
    lastError: ""
  });

  client.on("qr", async (qrText) => {
    try {
      const qrDataUrl = await qrcode.toDataURL(qrText);
      state.qr = qrDataUrl;
      state.status = "aguardando_qr";
      state.lastError = "";

      updateSessionRecord(empresa.id, {
        status: "aguardando_qr",
        qr: qrDataUrl,
        lastError: ""
      });

      console.log(`QR gerado para ${empresa.slug}`);
    } catch (err) {
      state.lastError = "Erro ao gerar QR.";
      state.status = "erro";

      updateSessionRecord(empresa.id, {
        status: "erro",
        lastError: "Erro ao gerar QR."
      });
    }
  });

  client.on("ready", () => {
    state.status = "conectado";
    state.qr = "";
    state.lastError = "";

    updateSessionRecord(empresa.id, {
      status: "conectado",
      qr: "",
      lastError: ""
    });

    console.log(`WhatsApp conectado: ${empresa.slug}`);
  });

  client.on("authenticated", () => {
    state.status = "autenticado";

    updateSessionRecord(empresa.id, {
      status: "autenticado",
      lastError: ""
    });
  });

  client.on("auth_failure", (msg) => {
    state.status = "erro";
    state.lastError = msg || "Falha de autenticação";

    updateSessionRecord(empresa.id, {
      status: "erro",
      lastError: msg || "Falha de autenticação"
    });

    console.error(`Auth failure ${empresa.slug}:`, msg);
  });

  client.on("disconnected", (reason) => {
    state.status = "desconectado";
    state.qr = "";
    state.lastError = reason || "Desconectado";

    updateSessionRecord(empresa.id, {
      status: "desconectado",
      qr: "",
      lastError: reason || "Desconectado"
    });

    console.log(`WhatsApp desconectado ${empresa.slug}:`, reason);
  });

  client.on("message", async (message) => {
    try {
      if (message.fromMe) return;
      if (message.from.includes("@g.us")) return;

      const texto = (message.body || "").trim();
      if (!texto) return;

      const empresaAtualizada = getEmpresaById(empresa.id);
      if (!empresaAtualizada) return;

      const boasVindas =
        empresaAtualizada.mensagens?.boasVindas ||
        `Olá! Seja bem-vindo(a) à ${empresaAtualizada.nome}.`;

      await message.reply(boasVindas);
    } catch (err) {
      console.error(`Erro ao responder mensagem da empresa ${empresa.slug}:`, err);
    }
  });

  client.initialize().catch((err) => {
    state.status = "erro";
    state.lastError = err.message || "Erro ao inicializar";

    updateSessionRecord(empresa.id, {
      status: "erro",
      lastError: err.message || "Erro ao inicializar"
    });

    console.error(`Erro init ${empresa.slug}:`, err);
  });

  return state;
}

async function destroyWhatsAppForEmpresa(empresa) {
  if (!empresa || !empresa.slug) {
    throw new Error("Empresa inválida.");
  }

  const state = whatsappClients.get(empresa.slug);

  if (state?.client) {
    try {
      await state.client.destroy();
    } catch (err) {
      console.error("Erro ao destruir client:", err.message);
    }
  }

  whatsappClients.delete(empresa.slug);

  updateSessionRecord(empresa.id, {
    status: "desconectado",
    qr: "",
    lastError: ""
  });
}

// ===== páginas públicas =====
app.get("/", (req, res) => {
  res.json({ ok: true, app: "Atende+ SaaS" });
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.get("/cliente.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "cliente.html"));
});

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.get("/cadastro.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "cadastro.html"));
});

// ===== auth públicas =====
app.post("/api/auth/cadastro", async (req, res) => {
  try {
    const { nome, email, senha, empresaNome, nicho, telefone } = req.body;

    if (!nome || !email || !senha || !empresaNome) {
      return res.status(400).json({
        ok: false,
        message: "Nome, email, senha e nome da empresa são obrigatórios."
      });
    }

    const db = readDB();

    const emailExiste = db.usuarios.some(
      (u) => u.email.toLowerCase() === String(email).toLowerCase()
    );

    if (emailExiste) {
      return res.status(409).json({
        ok: false,
        message: "Este email já está cadastrado."
      });
    }

    let baseSlug = slugify(empresaNome);
    let finalSlug = baseSlug || "empresa";
    let i = 1;

    while (db.empresas.some((e) => e.slug === finalSlug)) {
      finalSlug = `${baseSlug || "empresa"}-${i}`;
      i += 1;
    }

    const empresaId = `emp_${uuidv4()}`;
    const usuarioId = `usr_${uuidv4()}`;
    const senhaHash = await bcrypt.hash(String(senha), 10);

    const novaEmpresa = {
      id: empresaId,
      nome: empresaNome,
      slug: finalSlug,
      nicho: nicho || "",
      telefone: telefone || "",
      logo: "",
      plano: "start",
      status: "ativo",
      ia: {
        tom: "profissional e amigável",
        objetivo: "atender bem e converter clientes",
        personalidade: "comercial"
      },
      mensagens: {
        boasVindas: `Olá! Seja bem-vindo(a) à ${empresaNome}.`,
        atendente: "Perfeito! Um atendente vai falar com você em instantes.",
        pix: "Chave PIX: CONFIGURE_NO_PAINEL"
      },
      planos: [],
      faq: [],
      criadoEm: formatDate()
    };

    const novoUsuario = {
      id: usuarioId,
      nome,
      email,
      senhaHash,
      empresaId,
      tipo: "cliente",
      criadoEm: formatDate()
    };

    db.empresas.push(novaEmpresa);
    db.usuarios.push(novoUsuario);
    db.sessoesWhatsapp.push({
      empresaId,
      clientId: finalSlug,
      status: "desconectado",
      qr: "",
      lastError: "",
      atualizadoEm: formatDate()
    });

    writeDB(db);

    req.session.user = {
      id: novoUsuario.id,
      nome: novoUsuario.nome,
      email: novoUsuario.email,
      empresaId: novoUsuario.empresaId,
      tipo: novoUsuario.tipo
    };

    return res.json({
      ok: true,
      message: "Cadastro realizado com sucesso.",
      user: req.session.user,
      empresa: {
        id: novaEmpresa.id,
        nome: novaEmpresa.nome,
        slug: novaEmpresa.slug
      }
    });
  } catch (err) {
    console.error("Erro cadastro:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro interno ao realizar cadastro."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({
        ok: false,
        message: "Email e senha são obrigatórios."
      });
    }

    const db = readDB();

    // super admin
    if (
      db.superAdmin &&
      email.toLowerCase() === String(db.superAdmin.email).toLowerCase() &&
      (await bcrypt.compare(String(senha), db.superAdmin.senhaHash))
    ) {
      req.session.user = {
        id: "super_admin",
        nome: "Super Admin",
        email: db.superAdmin.email,
        empresaId: null,
        tipo: "super_admin"
      };

      return res.json({
        ok: true,
        user: req.session.user
      });
    }

    const usuario = db.usuarios.find(
      (u) => u.email.toLowerCase() === String(email).toLowerCase()
    );

    if (!usuario) {
      return res.status(401).json({
        ok: false,
        message: "Email ou senha inválidos."
      });
    }

    const senhaOk = await bcrypt.compare(String(senha), usuario.senhaHash);

    if (!senhaOk) {
      return res.status(401).json({
        ok: false,
        message: "Email ou senha inválidos."
      });
    }

    req.session.user = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      empresaId: usuario.empresaId,
      tipo: usuario.tipo
    };

    return res.json({
      ok: true,
      user: req.session.user
    });
  } catch (err) {
    console.error("Erro login:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro interno ao fazer login."
    });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ===== sessão =====
app.get("/api/session", authMiddleware, (req, res) => {
  res.json({
    ok: true,
    user: req.session.user
  });
});

// ===== super admin =====
app.get("/api/admin/empresas", authMiddleware, superAdminMiddleware, (req, res) => {
  const db = readDB();

  const empresas = db.empresas.map((empresa) => {
    const dono = db.usuarios.find((u) => u.empresaId === empresa.id);
    const sessao = db.sessoesWhatsapp.find((s) => s.empresaId === empresa.id);

    return {
      ...empresa,
      dono: dono
        ? {
            nome: dono.nome,
            email: dono.email
          }
        : null,
      sessaoWhatsapp: sessao || null
    };
  });

  res.json({ ok: true, empresas });
});

app.post("/api/admin/empresas", authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { nome, email, senha, empresaNome, nicho, telefone } = req.body;

    if (!nome || !email || !senha || !empresaNome) {
      return res.status(400).json({
        ok: false,
        message: "Nome, email, senha e nome da empresa são obrigatórios."
      });
    }

    const db = readDB();

    if (db.usuarios.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
      return res.status(409).json({
        ok: false,
        message: "Email já cadastrado."
      });
    }

    let baseSlug = slugify(empresaNome);
    let finalSlug = baseSlug || "empresa";
    let i = 1;

    while (db.empresas.some((e) => e.slug === finalSlug)) {
      finalSlug = `${baseSlug || "empresa"}-${i}`;
      i += 1;
    }

    const empresaId = `emp_${uuidv4()}`;
    const usuarioId = `usr_${uuidv4()}`;
    const senhaHash = await bcrypt.hash(String(senha), 10);

    const empresa = {
      id: empresaId,
      nome: empresaNome,
      slug: finalSlug,
      nicho: nicho || "",
      telefone: telefone || "",
      logo: "",
      plano: "start",
      status: "ativo",
      ia: {
        tom: "profissional e amigável",
        objetivo: "atender bem e converter clientes",
        personalidade: "comercial"
      },
      mensagens: {
        boasVindas: `Olá! Seja bem-vindo(a) à ${empresaNome}.`,
        atendente: "Perfeito! Um atendente vai falar com você em instantes.",
        pix: "Chave PIX: CONFIGURE_NO_PAINEL"
      },
      planos: [],
      faq: [],
      criadoEm: formatDate()
    };

    const usuario = {
      id: usuarioId,
      nome,
      email,
      senhaHash,
      empresaId,
      tipo: "cliente",
      criadoEm: formatDate()
    };

    db.empresas.push(empresa);
    db.usuarios.push(usuario);
    db.sessoesWhatsapp.push({
      empresaId,
      clientId: finalSlug,
      status: "desconectado",
      qr: "",
      lastError: "",
      atualizadoEm: formatDate()
    });

    writeDB(db);

    res.json({
      ok: true,
      empresa,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email
      }
    });
  } catch (err) {
    console.error("Erro criar empresa admin:", err);
    res.status(500).json({
      ok: false,
      message: "Erro ao criar empresa."
    });
  }
});

// ===== cliente =====
app.get("/api/cliente/empresa", authMiddleware, clienteMiddleware, (req, res) => {
  const empresa = getEmpresaById(req.session.user.empresaId);

  if (!empresa) {
    return res.status(404).json({
      ok: false,
      message: "Empresa não encontrada."
    });
  }

  const db = readDB();
  const sessao = db.sessoesWhatsapp.find((s) => s.empresaId === empresa.id) || null;

  res.json({
    ok: true,
    empresa,
    sessaoWhatsapp: sessao
  });
});

app.put("/api/cliente/empresa", authMiddleware, clienteMiddleware, (req, res) => {
  try {
    const db = readDB();
    const empresa = db.empresas.find((e) => e.id === req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    const { nome, nicho, telefone, ia, mensagens } = req.body;

    if (nome !== undefined) empresa.nome = nome;
    if (nicho !== undefined) empresa.nicho = nicho;
    if (telefone !== undefined) empresa.telefone = telefone;

    if (ia && typeof ia === "object") {
      empresa.ia = {
        ...(empresa.ia || {}),
        ...ia
      };
    }

    if (mensagens && typeof mensagens === "object") {
      empresa.mensagens = {
        ...(empresa.mensagens || {}),
        ...mensagens
      };
    }

    writeDB(db);

    return res.json({
      ok: true,
      empresa
    });
  } catch (error) {
    console.error("Erro ao atualizar empresa:", error);
    return res.status(500).json({
      ok: false,
      message: "Erro ao atualizar dados da empresa."
    });
  }
});

// ===== planos =====
app.get("/api/cliente/planos", authMiddleware, clienteMiddleware, (req, res) => {
  const empresa = getEmpresaById(req.session.user.empresaId);

  if (!empresa) {
    return res.status(404).json({
      ok: false,
      message: "Empresa não encontrada."
    });
  }

  res.json({
    ok: true,
    planos: empresa.planos || []
  });
});

app.post("/api/cliente/planos", authMiddleware, clienteMiddleware, (req, res) => {
  try {
    const db = readDB();
    const empresa = db.empresas.find((e) => e.id === req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    const { nome, valor, descricao } = req.body;

    if (!nome || !valor) {
      return res.status(400).json({
        ok: false,
        message: "Nome e valor são obrigatórios."
      });
    }

    if (!Array.isArray(empresa.planos)) {
      empresa.planos = [];
    }

    const novoPlano = {
      id: `pl_${uuidv4()}`,
      nome,
      valor,
      descricao: descricao || ""
    };

    empresa.planos.push(novoPlano);
    writeDB(db);

    res.json({
      ok: true,
      plano: novoPlano
    });
  } catch (error) {
    console.error("Erro ao criar plano:", error);
    res.status(500).json({
      ok: false,
      message: "Erro ao criar plano."
    });
  }
});

app.delete("/api/cliente/planos/:id", authMiddleware, clienteMiddleware, (req, res) => {
  try {
    const db = readDB();
    const empresa = db.empresas.find((e) => e.id === req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    const index = (empresa.planos || []).findIndex((p) => p.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        message: "Plano não encontrado."
      });
    }

    empresa.planos.splice(index, 1);
    writeDB(db);

    res.json({ ok: true });
  } catch (error) {
    console.error("Erro ao excluir plano:", error);
    res.status(500).json({
      ok: false,
      message: "Erro ao excluir plano."
    });
  }
});

// ===== faq =====
app.get("/api/cliente/faq", authMiddleware, clienteMiddleware, (req, res) => {
  const empresa = getEmpresaById(req.session.user.empresaId);

  if (!empresa) {
    return res.status(404).json({
      ok: false,
      message: "Empresa não encontrada."
    });
  }

  res.json({
    ok: true,
    faq: empresa.faq || []
  });
});

app.post("/api/cliente/faq", authMiddleware, clienteMiddleware, (req, res) => {
  try {
    const db = readDB();
    const empresa = db.empresas.find((e) => e.id === req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    const { pergunta, resposta } = req.body;

    if (!pergunta || !resposta) {
      return res.status(400).json({
        ok: false,
        message: "Pergunta e resposta são obrigatórias."
      });
    }

    if (!Array.isArray(empresa.faq)) {
      empresa.faq = [];
    }

    const novoFAQ = {
      id: `faq_${uuidv4()}`,
      pergunta,
      resposta
    };

    empresa.faq.push(novoFAQ);
    writeDB(db);

    res.json({
      ok: true,
      faq: novoFAQ
    });
  } catch (error) {
    console.error("Erro ao criar FAQ:", error);
    res.status(500).json({
      ok: false,
      message: "Erro ao criar FAQ."
    });
  }
});

app.delete("/api/cliente/faq/:id", authMiddleware, clienteMiddleware, (req, res) => {
  try {
    const db = readDB();
    const empresa = db.empresas.find((e) => e.id === req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    const index = (empresa.faq || []).findIndex((f) => f.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        message: "FAQ não encontrado."
      });
    }

    empresa.faq.splice(index, 1);
    writeDB(db);

    res.json({ ok: true });
  } catch (error) {
    console.error("Erro ao excluir FAQ:", error);
    res.status(500).json({
      ok: false,
      message: "Erro ao excluir FAQ."
    });
  }
});

// ===== whatsapp por empresa =====
app.post("/api/cliente/whatsapp/iniciar", authMiddleware, clienteMiddleware, async (req, res) => {
  try {
    const empresa = getEmpresaById(req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    await initWhatsAppForEmpresa(empresa);

    res.json({
      ok: true,
      message: "Inicialização do WhatsApp iniciada."
    });
  } catch (err) {
    console.error("Erro iniciar whatsapp:", err);
    res.status(500).json({
      ok: false,
      message: "Erro ao iniciar WhatsApp."
    });
  }
});

app.get("/api/cliente/whatsapp/status", authMiddleware, clienteMiddleware, (req, res) => {
  const db = readDB();
  const sessao = db.sessoesWhatsapp.find((s) => s.empresaId === req.session.user.empresaId);

  if (!sessao) {
    return res.status(404).json({
      ok: false,
      message: "Sessão não encontrada."
    });
  }

  res.json({
    ok: true,
    sessao
  });
});

app.get("/api/cliente/whatsapp/qr", authMiddleware, clienteMiddleware, (req, res) => {
  const db = readDB();
  const sessao = db.sessoesWhatsapp.find((s) => s.empresaId === req.session.user.empresaId);

  if (!sessao) {
    return res.status(404).json({
      ok: false,
      message: "Sessão não encontrada."
    });
  }

  res.json({
    ok: true,
    status: sessao.status,
    qr: sessao.qr || "",
    lastError: sessao.lastError || ""
  });
});

app.post("/api/cliente/whatsapp/desconectar", authMiddleware, clienteMiddleware, async (req, res) => {
  try {
    const empresa = getEmpresaById(req.session.user.empresaId);

    if (!empresa) {
      return res.status(404).json({
        ok: false,
        message: "Empresa não encontrada."
      });
    }

    await destroyWhatsAppForEmpresa(empresa);

    res.json({
      ok: true,
      message: "WhatsApp desconectado."
    });
  } catch (err) {
    console.error("Erro desconectar:", err);
    res.status(500).json({
      ok: false,
      message: "Erro ao desconectar WhatsApp."
    });
  }
});

// ===== start =====
app.listen(PORT, () => {
  ensureDB();
  console.log(`🚀 Atende+ SaaS rodando em http://localhost:${PORT}`);
});