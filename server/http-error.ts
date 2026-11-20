/**
 * An error whose message is meant for the user, with the HTTP status to answer
 * with. The app's error handler sends it as `{ error: message }`; any other
 * error becomes a generic 500.
 */
export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
