const {
  BaseKonnector,
  requestFactory,
  saveBills,
  scrape,
  log,
  utils
} = require('cozy-konnector-libs')
const cheerio = require('cheerio')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'Verisure'
const baseUrl = 'https://customers.securitasdirect.fr'
const apiUrl = baseUrl+"/owa-api/graphql";
var user = "";

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  let hash;
  let ID;

  log('info', 'Authenticating ...');
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS');
  if (await login.bind(this)(fields.login, fields.password)){
    log('info', 'Successfully logged in');
    user = fields.login; //If user logged, store keep username in global variable.

    try {
      let installations = new Array();
      //Fetching installation number if needed
      if (!fields.installNumber || fields.installNumber == ""){
        log('info', 'Fetching the list of installation');
        installations = await getInstallations();
      } else {
        log('info', 'Processing provided installation number');
        installations.push(fields.installNumber);
      }

      log('info', 'Fetching the list of invoices per installation')
      for (let i in installations){
        let installation = installations[i];
       
        //Retreving the Invoice list by installation
        let invoices = await getInvoices(installation);

        log('info', 'Collecting documents')
        let bills = await parseInvoices(installation, invoices);

        // Here we use the saveBills function even if what we fetch are not bills,
        // but this is the most common case in connectors
        log('info', 'Saving data to Cozy')
        await saveBills(bills, fields.folderPath, {
          identifiers: ['verisure', 'securitas-direct', 'securitas'],
          contentType: 'application/pdf',
          sourceAccount: installation,
          sourceAccountIdentifier: fields.login,
          fileIdAttributes: ['metadata.reference', 'metadata.installationNumber']
        });
      }
    } catch (error) {
      log('error', 'An error occured, loggin out.')
      throw error;
    } finally {
      if (await logout.bind(this)())
        log('info', 'Successfully logged out');
      else
        log('error', 'Loggin out failed. Exiting.');
    }
  } else {
    log('error', 'Login failed. Exiting...')
  }
}

async function login(username, password) {
  log('debug', 'login start');
  ID = calculateID(username);
  
  let myHeaders = new Headers();
  myHeaders.append("Content-Type", "application/json");

  let raw = JSON.stringify({
    "operationName": "mkLoginToken",
    "variables": {
      "id": ID,
      "country": "FR",
      "callby": "OWP_10",
      "lang": "fr",
      "user": username,
      "password": password
    },
    "query": "mutation mkLoginToken($user: String!, $password: String!, $id: String!, $country: String!, $lang: String!, $callby: String!) {\n  xSLoginToken(user: $user, password: $password, id: $id, country: $country, lang: $lang, callby: $callby) {\n    res\n    msg\n    hash\n    lang\n    legals\n    mainUser\n    changePassword\n    needDeviceAuthorization\n  }\n}\n"
  });

  let requestOptions = {
    method: 'POST',
    headers: myHeaders,
    body: raw,
    redirect: 'follow'
  };

  let response = await fetch(apiUrl, requestOptions);
  let jsonData = await response.json();
  let errors = jsonData.errors;
  let xSLoginToken = jsonData.data.xSLoginToken;
  if (response.ok && jsonData.errors == undefined ){
    hash = xSLoginToken.hash;
    log('debug',xSLoginToken.res + " - " + xSLoginToken.msg);
    return true;
  } else {
    for (let i in errors){
      log('error', errors[i].name + " - " + errors[i].message);
      return false;
    }
  }
}

function getHeaders(){
  log('debug', 'getHeaders start');
    var auth = JSON.stringify({
    "user": user,
    "id":ID,
    "country": "FR",
    "lang": "fr",
    "callby": "OWP_10",
    "hash": hash
  });

  var myHeaders = new Headers();
  myHeaders.append("auth", auth);
  myHeaders.append("Content-Type", "application/json");
  log('debug', 'getHeaders ends');
  return myHeaders;
}

//Function to log out the user at the end of the process
async function logout(){
  log('debug', 'logout start');

  let raw = JSON.stringify({
    "operationName": "Logout",
    "variables": {},
    "query": "mutation Logout {\n  xSLogout\n}\n"
  });

  let requestOptions = {
    method: 'POST',
    headers: getHeaders(),
    body: raw,
    redirect: 'follow'
  };

  let response = await fetch(apiUrl, requestOptions);
  let jsonData = await response.json();
  let errors = jsonData.errors;
  let xSLogout = jsonData.data.xSLogout;
  if (response.ok && jsonData.errors == undefined ){
    log('debug',xSLogout.res + " - " + xSLogout.msg);
    return true;
  } else {
    for (let i in errors){
      log('error', errors[i].name + " - " + errors[i].message);
      return false;
    }
  }
}

async function getInstallations(){
  log('debug', 'getInstallations start');

  let raw = JSON.stringify({
    "operationName": "mkInstallationList",
    "variables": {},
    "query": "query mkInstallationList {\n  xSInstallations {\n    installations {\n      numinst\n      alias\n      panel\n      type\n      name\n      surname\n      address\n      city\n      postcode\n      province\n      email\n      phone\n    }\n  }\n}\n"
  });

  let requestOptions = {
    method: 'POST',
    headers: getHeaders(),
    body: raw,
    redirect: 'follow'
  };

  let response = await fetch(apiUrl, requestOptions);
  let jsonData = await response.json();
  let errors = jsonData.errors;
  let xSInstallations = jsonData.data.xSInstallations;
  let result = new Array();
  if (response.ok && jsonData.errors == undefined ){
    log('info',"Found " + xSInstallations.installations.lenght + " installations.");
    for (let i in xSInstallations.installations){
      let installation = xSInstallations.installations[i];
      log('debug',"Installation " + installation.numinst + " " + installation.alias);
      result.push(installation.numinst);
    }
  } else if (jsonData.errors != undefined) {
    for (let i in errors){
      log('error', errors[i].name + " - " + errors[i].message);
    }
  }else {
    //TODO HTTP Errors
  }
  log('debug', 'getInstallations end');
  return result;
}

async function getInvoices(numinst){
  log('debug', 'getInvoices start');

  let raw = JSON.stringify({
    "operationName": "mkInvoiceList",
    "variables": {
      "numinst": numinst
    },
    "query": "query mkInvoiceList($numinst: String!, $type: BillType) {\n  xSInvoiceList(numinst: $numinst, billType: $type) {\n    config {\n      address\n      city\n      owner\n      postcode\n      province\n    }\n    invoices {\n      numInvoice\n      contract\n      date\n      total\n    }\n  }\n}\n"
  });

  let requestOptions = {
    method: 'POST',
    headers: getHeaders(),
    body: raw,
    redirect: 'follow'
  };

  let response = await fetch(apiUrl, requestOptions);
  let jsonData = await response.json();
  let errors = jsonData.errors;
  let xSInvoiceList = jsonData.data.xSInvoiceList;
  let result = new Array();
  if (response.ok && jsonData.errors == undefined ){
    log('info', "Found " + xSInvoiceList.invoices.length + " invoices for installation " + numinst);
    for (let i in xSInvoiceList.invoices){
      let invoice = xSInvoiceList.invoices[i];
      result.push(invoice);
    }
  } else {
    for (let i in errors){
      log('error', errors[i].name + " - " + errors[i].message);
    }
  }
  log('debug', 'getInvoices end');
  return result;
}

//Parse retrurned invoices of a specific installation number
async function parseInvoices(installation, invoices) {
  log('debug', 'parseInvoices start');
    let bills = new Array();
    for (let i in invoices){
      let invoice = invoices[i];
      let invDate = new Date(invoice.date);
      let amount = normalizePrice(invoice.total);
      let cur = 'EUR';
      let pdfData = await getContent(installation, invoice.numInvoice, invoice.contract);
      let bill = {
        'date': invDate,
        'carbonCopy': true,
        'amount': Number(amount),
        'currency': cur,
        'filestream': getPDFContent(pdfData),
        'filename': `${utils.formatDate(invDate)}_${VENDOR}_${amount.toFixed(2)}${cur}_${installation}_${invoice.numInvoice}.pdf`,
        'vendor': VENDOR,
        'type': 'Security',
        'subtype': 'Alarm',
        'metadata': {
          'installationNumber': installation,
          'reference': invoice.numInvoice,
          'mime': 'application/pdf'
        }
      }
      bills.push(bill);
    }
    log('debug', 'parseInvoices end');
    return bills;
}

//Retreive invoice's PDF content encoded in base64
async function getContent(numInst, numInvoice, numContract){
  log('debug', 'getContent start');

  let raw = JSON.stringify({
    "operationName": "mkInvoice",
    "variables": {
        "numinst": numInst,
        "numInvoice": numInvoice,
        "contract": numContract
    },
    "query": "query mkInvoice($numinst: String!, $numInvoice: String!, $contract: String!, $type: BillType) {\n  xSInvoice(numinst: $numinst, numInvoice: $numInvoice, contract: $contract, billType: $type) {\n    data\n  }\n}\n"
});

  let requestOptions = {
    method: 'POST',
    headers: getHeaders(),
    body: raw,
    redirect: 'follow'
  };

  let response = await fetch(apiUrl, requestOptions);
  let jsonData = await response.json();
  let errors = jsonData.errors;
  let xSInvoice = !!jsonData.data ? jsonData.data.xSInvoice : undefined;
  let pdfData;
  if (response.ok && jsonData.errors == undefined ){
    if (!!xSInvoice.data) {
      log('info', `Found content for invoice ${numInst} - ${numInvoice}`);
      log('debug', 'Content lenght = '+xSInvoice.data.length);
      pdfData = xSInvoice.data;
    }
  } else {
    for (let i in errors){
      log('error', errors[i].name + " - " + errors[i].message);
    }
  }
  return pdfData;
}


//Convert file content from Base64
function getPDFContent(contenu) {
  log('debug', 'getPDFContent start');
  return Buffer.from(contenu, 'base64');
};

//Function to calculate the ID value based on Username
function calculateID(username) {
  let current = new Date();
  return "OWP_______________"
            + username
            + "_______________"
            + current.getFullYear()
            + current.getMonth()
            + current.getDate()
            + current.getHours()
            + current.getMinutes()
            + current.getSeconds();
}

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('€', '').trim())
}
