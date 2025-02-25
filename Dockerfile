# build rust binary from src
FROM rust:1.85-slim AS builder

WORKDIR /usr/src/app

COPY ./src ./src
COPY ./Cargo.* .

RUN cargo build --release

# use node image to run the binary
FROM node:23-slim AS runtime

WORKDIR /usr/src/app

# install psql
RUN apt-get update && apt-get install -y postgresql-client curl

# copy built binary from builder
COPY --from=builder /usr/src/app/target/release/fil-deal-ingester .

# copy package.json and package-lock.lock
COPY ./package.json .
COPY ./package-lock.json .

# copy scripts 
COPY ./scripts ./scripts
COPY ./run.sh .

# install node modules
RUN npm install

CMD ["./run.sh"]
