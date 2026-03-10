const path = require("path");
const quoteService = require("../services/quoteService");
const projectService = require("../services/project.service");
const userRepository = require("../repositories/user.repository");

function getBaseUrl(req) {
  return (
    process.env.BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`
  );
}

function extractCustomerEmailFromSession(session) {
  if (!session || typeof session !== "object") return "";
  const candidates = [
    session.customer_details && session.customer_details.email,
    session.customer_email,
    session.customer && session.customer.email,
    session.metadata && session.metadata.email
  ];

  for (const value of candidates) {
    const normalized = quoteService.normalizeEmail(value || "");
    if (normalized) return normalized;
  }
  return "";
}

function createClientSuccessController({ stripe }) {
  return async function clientSuccessController(req, res) {
    if (!stripe) {
      return res.status(500).send("Stripe is not configured.");
    }

    const sessionId = String((req.query && req.query.session_id) || "").trim();
    if (!sessionId) {
      return res.status(400).send("Missing session_id.");
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const metadata = (session && session.metadata) || {};
      const quoteId = String(metadata.quote_id || metadata.quoteId || "").trim();
      const customerEmail = extractCustomerEmailFromSession(session);

      let user = null;
      if (customerEmail) {
        user = await userRepository.findUserByEmail(customerEmail);
        if (!user) {
          user = await userRepository.createUser(customerEmail);
        }
      }

      let project = await projectService.getProjectByQuoteId(quoteId);

      if (!project && quoteId) {
        const quote = await quoteService.getQuoteById(quoteId);
        const wordpressUrl = String(
          metadata.wordpress_url ||
          metadata.siteUrl ||
          metadata.website_url ||
          (quote && quote.siteUrl) ||
          ""
        ).trim();

        project = await projectService.createQueuedProject({
          quoteId,
          userId: user && user.id ? user.id : null,
          customerEmail: customerEmail || (quote && quote.email) || null,
          wordpressUrl: wordpressUrl || null
        });
      }

      project = await projectService.ensureProjectAccessToken(project);

      if (!project || !project.id || !project.accessToken) {
        return res
          .status(404)
          .send("Project access link is not ready yet. Please check your email.");
      }

      const redirectUrl =
        `${getBaseUrl(req)}/project-area?project=${encodeURIComponent(project.id)}` +
        `&token=${encodeURIComponent(project.accessToken)}`;
      return res.redirect(302, redirectUrl);
    } catch (error) {
      return res.status(500).send(
        `Could not verify checkout session: ${error && error.message ? error.message : "Unknown error"}`
      );
    }
  };
}

function createProjectAreaPageController({ appRoot }) {
  return async function projectAreaPageController(req, res) {
    const projectId = String((req.query && req.query.project) || "").trim();
    const accessToken = String((req.query && req.query.token) || "").trim();

    if (!projectId || !accessToken) {
      return res
        .status(401)
        .send("Session expired. Please check your email for your project access link.");
    }

    try {
      const project = await projectService.getProjectById(projectId);
      const isValid = projectService.isProjectAccessValid(project, accessToken);

      if (!isValid) {
        return res
          .status(401)
          .send("Session expired. Please check your email for your project access link.");
      }

      return res.sendFile(path.join(appRoot, "project-area.html"));
    } catch (_error) {
      return res
        .status(401)
        .send("Session expired. Please check your email for your project access link.");
    }
  };
}

module.exports = {
  createClientSuccessController,
  createProjectAreaPageController
};
