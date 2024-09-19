import { google } from "googleapis";
import type { NextApiRequest, NextApiResponse } from "next";

import { createDefaultInstallation, isAppInstalled } from "@calcom/app-store/_utils/installation";
import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { defaultHandler, defaultResponder } from "@calcom/lib/server";
import { DomainWideDelegationRepository } from "@calcom/lib/server/repository/domainWideDelegation";

import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { metadata } from "../_metadata";
import { SCOPES } from "../lib/constants";
import { getGoogleAppKeys } from "../lib/getGoogleAppKeys";

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  const loggedInUser = req.session?.user;
  if (!loggedInUser) {
    throw new HttpError({ statusCode: 401, message: "You must be logged in to do this" });
  }

  // Ideally this should never happen, as email is there in session user but typings aren't accurate it seems
  // TODO: So, confirm and later fix the typings
  if (!loggedInUser.email) {
    throw new HttpError({ statusCode: 400, message: "Session user must have an email" });
  }

  const domainWideDelegation = await DomainWideDelegationRepository.findUniqueByOrganizationMemberEmail({
    email: loggedInUser.email,
  });

  if (domainWideDelegation && domainWideDelegation.enabled) {
    if (domainWideDelegation.workspacePlatform.slug !== "google") {
      logger.debug("Domain-wide delegation isn't compatible with this app", {
        domainWideDelegation: domainWideDelegation.workspacePlatform.slug,
      });
    } else {
      logger.debug("Domain-wide delegation is enabled");
      // FIXME: How about if the app is installed for a team? Is that possible? I think not.
      // We should figure it out and add appropriate comment here.
      if (await isAppInstalled({ appId: metadata.slug, userId: loggedInUser.id })) {
        throw new HttpError({
          statusCode: 422,
          message: "Domain-wide delegation restricts adding more than one installation",
        });
      }

      await createDefaultInstallation({
        appType: metadata.type,
        user: loggedInUser,
        slug: metadata.slug,
        delegatedToId: domainWideDelegation.id,
        key: {
          // FIXME: zod validation somewhere requires access_token, when infact it isn't needed for domain-wide delegation
          access_token: "NOT_A_TOKEN",
        },
      });
      res.status(200).json({ message: "App successfully installed and is using delegated credentials" });
      return;
    }
  }

  const { client_id, client_secret } = await getGoogleAppKeys();
  const redirect_uri = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/googlecalendar/callback`;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    // A refresh token is only returned the first time the user
    // consents to providing access.  For illustration purposes,
    // setting the prompt to 'consent' will force this consent
    // every time, forcing a refresh_token to be returned.
    prompt: "consent",
    state: encodeOAuthState(req),
  });

  res.status(200).json({ url: authUrl });
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(getHandler) }),
});
