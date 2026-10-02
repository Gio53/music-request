export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ServiceError extends HttpError {
  constructor(
    public service: "jellyfin" | "lidarr" | "youtube",
    message: string,
    status = 502,
  ) {
    super(status, message);
    this.name = "ServiceError";
  }
}
